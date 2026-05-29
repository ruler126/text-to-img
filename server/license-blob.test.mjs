import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeFileBlobStore } from "./file-blob-store.mjs";
import { makeBlobLicenseStore } from "./license-blob.mjs";
import { createApiHandler } from "./api-handler.mjs";
import { HttpError } from "./errors.mjs";

const makeStore = async () => {
  const root = await mkdtemp(join(tmpdir(), "license-blob-"));
  const blobStore = makeFileBlobStore({ root });
  const store = makeBlobLicenseStore({
    blobStore,
    sessionSecret: "test-secret",
    allowTestReset: true,
  });
  return {
    store,
    root,
    cleanup: async () => rm(root, { recursive: true, force: true }),
  };
};

test("batch generation creates unique mixed six-character cards", async () => {
  const { store, cleanup } = await makeStore();
  try {
    const cards = await store.createCards({ totalUses: 20, count: 50, note: "batch" });
    assert.equal(cards.length, 50);
    assert.equal(new Set(cards.map((card) => card.code)).size, 50);
    for (const card of cards) {
      assert.match(card.code, /^[A-Z0-9]{6}$/);
      assert.match(card.code, /[A-Z]/);
      assert.match(card.code, /[0-9]/);
      assert.equal(card.totalUses, 20);
      assert.equal(card.note, "batch");
    }
  } finally {
    await cleanup();
  }
});

test("login, usage success, fail, and idempotent success", async () => {
  const { store, cleanup } = await makeStore();
  try {
    const [card] = await store.createCards({ totalUses: 10, count: 1 });
    const login = await store.loginCard(card.code);
    assert.equal(login.card.remainingUses, 10);

    const first = await store.startUsage(login.token);
    let current = await store.completeUsage(login.token, first.id, true);
    assert.equal(current.usedUses, 1);
    assert.equal(current.remainingUses, 9);
    current = await store.completeUsage(login.token, first.id, true);
    assert.equal(current.usedUses, 1);

    const second = await store.startUsage(login.token);
    current = await store.completeUsage(login.token, second.id, false);
    assert.equal(current.usedUses, 1);
    assert.equal(current.remainingUses, 9);
  } finally {
    await cleanup();
  }
});

test("disabled and exhausted cards cannot be used", async () => {
  const { store, cleanup } = await makeStore();
  try {
    const [card] = await store.createCards({ totalUses: 10, count: 1 });
    await store.updateCard(card.code, { status: "disabled" });
    await assert.rejects(() => store.loginCard(card.code), HttpError);

    const [small] = await store.createCards({ totalUses: 10, count: 1 });
    const login = await store.loginCard(small.code);
    for (let index = 0; index < 10; index += 1) {
      const reservation = await store.startUsage(login.token);
      await store.completeUsage(login.token, reservation.id, true);
    }
    await assert.rejects(() => store.startUsage(login.token), HttpError);
  } finally {
    await cleanup();
  }
});

test("last available use can only be reserved once", async () => {
  const { store, cleanup } = await makeStore();
  try {
    const [card] = await store.createCards({ totalUses: 10, count: 1 });
    const login = await store.loginCard(card.code);
    for (let index = 0; index < 9; index += 1) {
      const reservation = await store.startUsage(login.token);
      await store.completeUsage(login.token, reservation.id, true);
    }
    await store.startUsage(login.token);
    await assert.rejects(() => store.startUsage(login.token), HttpError);
  } finally {
    await cleanup();
  }
});

test("parallel reservations do not exceed remaining uses", async () => {
  const { store, cleanup } = await makeStore();
  try {
    const [card] = await store.createCards({ totalUses: 10, count: 1 });
    const login = await store.loginCard(card.code);
    for (let index = 0; index < 9; index += 1) {
      const reservation = await store.startUsage(login.token);
      await store.completeUsage(login.token, reservation.id, true);
    }

    const attempts = await Promise.allSettled([
      store.startUsage(login.token),
      store.startUsage(login.token),
      store.startUsage(login.token),
    ]);
    assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((item) => item.status === "rejected").length, 2);
  } finally {
    await cleanup();
  }
});

test("server image proxy returns a pending reservation without confirming usage", async () => {
  const { store, cleanup } = await makeStore();
  const originalFetch = globalThis.fetch;
  try {
    const [card] = await store.createCards({ totalUses: 10, count: 1 });
    const login = await store.loginCard(card.code);
    globalThis.fetch = async (url) => {
      assert.match(String(url), /\/images\/generations$/);
      return new Response(JSON.stringify({ data: [{ b64_json: "AQID" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const handler = createApiHandler({
      store,
      serverApiConfig: {
        baseURL: "https://api.example.test/v1",
        apiKey: "test-key",
        model: "test-model",
      },
    });
    const response = await handler(new Request("http://localhost/api/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `card_session=${encodeURIComponent(login.token)}`,
      },
      body: JSON.stringify({
        prompt: "make a product image",
        size: "1024x1024",
        ratio: "1:1",
        quality: "standard",
      }),
    }));
    assert.equal(response.status, 200);

    const payload = await response.json();
    assert.equal(payload.image.b64Json, "AQID");
    assert.equal(payload.job.status, "completed");
    assert.ok(payload.reservation.id);
    assert.equal(payload.card, undefined);

    let current = await store.getCard(card.code);
    assert.equal(current.usedUses, 0);
    assert.equal(current.remainingUses, 10);

    current = await store.completeUsage(login.token, payload.reservation.id, true);
    assert.equal(current.usedUses, 1);
    assert.equal(current.remainingUses, 9);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup();
  }
});

test("server image proxy can complete an async upstream task without confirming usage", async () => {
  const { store, cleanup } = await makeStore();
  const originalFetch = globalThis.fetch;
  try {
    const [card] = await store.createCards({ totalUses: 10, count: 1 });
    const login = await store.loginCard(card.code);
    let fetchCount = 0;
    globalThis.fetch = async (url) => {
      fetchCount += 1;
      if (String(url).endsWith("/images/generations")) {
        return new Response(JSON.stringify({ data: { id: "upstream-task-1", status: "queued" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      assert.match(String(url), /\/tasks\/upstream-task-1$/);
      return new Response(JSON.stringify({ data: { status: "completed", b64_json: "BAUG" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const handler = createApiHandler({
      store,
      serverApiConfig: {
        baseURL: "https://api.example.test/v1",
        apiKey: "test-key",
        model: "test-model",
      },
    });
    const headers = {
      "Content-Type": "application/json",
      Cookie: `card_session=${encodeURIComponent(login.token)}`,
    };
    const submitResponse = await handler(new Request("http://localhost/api/images/generations", {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "make a product image",
        size: "1024x1024",
        ratio: "1:1",
        quality: "standard",
      }),
    }));
    assert.equal(submitResponse.status, 200);

    const submitPayload = await submitResponse.json();
    assert.equal(submitPayload.job.status, "pending");
    assert.equal(submitPayload.image, undefined);
    assert.ok(submitPayload.reservation.id);

    let current = await store.getCard(card.code);
    assert.equal(current.usedUses, 0);
    assert.equal(current.remainingUses, 10);

    const jobResponse = await handler(new Request(`http://localhost/api/images/jobs/${submitPayload.job.id}`, {
      headers,
    }));
    assert.equal(jobResponse.status, 200);
    const jobPayload = await jobResponse.json();
    assert.equal(jobPayload.job.status, "completed");
    assert.equal(jobPayload.image.b64Json, "BAUG");
    assert.equal(fetchCount, 2);

    current = await store.getCard(card.code);
    assert.equal(current.usedUses, 0);
    assert.equal(current.remainingUses, 10);

    current = await store.completeUsage(login.token, submitPayload.reservation.id, true);
    assert.equal(current.usedUses, 1);
    assert.equal(current.remainingUses, 9);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup();
  }
});

test("server image proxy recognizes nested async task result shapes", async () => {
  const { store, cleanup } = await makeStore();
  const originalFetch = globalThis.fetch;
  try {
    const [card] = await store.createCards({ totalUses: 10, count: 1 });
    const login = await store.loginCard(card.code);
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.endsWith("/images/generations")) {
        return new Response(JSON.stringify({ data: [{ id: "nested-task-1", status: "queued" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (value.endsWith("/tasks/nested-task-1")) {
        return new Response(JSON.stringify({
          data: [{
            status: "succeeded",
            output: {
              images: [{ url: "https://cdn.example.test/generated.png" }],
            },
          }],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      assert.equal(value, "https://cdn.example.test/generated.png");
      return new Response(Buffer.from([7, 8, 9]), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    };

    const handler = createApiHandler({
      store,
      serverApiConfig: {
        baseURL: "https://api.example.test/v1",
        apiKey: "test-key",
        model: "test-model",
      },
    });
    const headers = {
      "Content-Type": "application/json",
      Cookie: `card_session=${encodeURIComponent(login.token)}`,
    };
    const submitResponse = await handler(new Request("http://localhost/api/images/generations", {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "make a product image",
        size: "1024x1024",
        ratio: "1:1",
        quality: "standard",
      }),
    }));
    assert.equal(submitResponse.status, 200);
    const submitPayload = await submitResponse.json();
    assert.equal(submitPayload.job.status, "pending");

    const jobResponse = await handler(new Request(`http://localhost/api/images/jobs/${submitPayload.job.id}`, {
      headers,
    }));
    assert.equal(jobResponse.status, 200);
    const jobPayload = await jobResponse.json();
    assert.equal(jobPayload.job.status, "completed");
    assert.equal(jobPayload.image.b64Json, "BwgJ");

    const current = await store.getCard(card.code);
    assert.equal(current.usedUses, 0);
    assert.equal(current.remainingUses, 10);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup();
  }
});
