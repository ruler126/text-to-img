import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeFileBlobStore } from "./file-blob-store.mjs";
import { makeBlobLicenseStore } from "./license-blob.mjs";
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
