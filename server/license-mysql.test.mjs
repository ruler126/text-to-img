import test from "node:test";
import assert from "node:assert/strict";
import { makeMysqlLicenseStore } from "./license-mysql.mjs";
import { HttpError } from "./errors.mjs";

const databaseUrl = process.env.MYSQL_TEST_DATABASE_URL;

const makeStore = async () => {
  const store = await makeMysqlLicenseStore({
    databaseUrl,
    sessionSecret: "test-secret",
    allowTestReset: true,
  });
  await store.dangerouslyClearForTests();
  return store;
};

if (!databaseUrl) {
  test("MySQL license store tests require MYSQL_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  test("batch generation creates unique mixed six-character cards", async () => {
    const store = await makeStore();
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
    await store.close();
  });

  test("login, usage success, fail, and idempotent success", async () => {
    const store = await makeStore();
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
    await store.close();
  });

  test("disabled and exhausted cards cannot be used", async () => {
    const store = await makeStore();
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
    await store.close();
  });

  test("last available use can only be reserved once", async () => {
    const store = await makeStore();
    const [card] = await store.createCards({ totalUses: 10, count: 1 });
    const login = await store.loginCard(card.code);
    for (let index = 0; index < 9; index += 1) {
      const reservation = await store.startUsage(login.token);
      await store.completeUsage(login.token, reservation.id, true);
    }
    await store.startUsage(login.token);
    await assert.rejects(() => store.startUsage(login.token), HttpError);
    await store.close();
  });

  test("parallel reservations do not exceed remaining uses", async () => {
    const store = await makeStore();
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
    await store.close();
  });
}
