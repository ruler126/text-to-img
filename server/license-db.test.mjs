import test from "node:test";
import assert from "node:assert/strict";
import { makeLicenseStore, HttpError } from "./license-db.mjs";

const makeStore = () => makeLicenseStore({ dbPath: ":memory:", sessionSecret: "test-secret" });

test("batch generation creates unique mixed six-character cards", () => {
  const store = makeStore();
  const cards = store.createCards({ totalUses: 20, count: 50, note: "batch" });
  assert.equal(cards.length, 50);
  assert.equal(new Set(cards.map((card) => card.code)).size, 50);
  for (const card of cards) {
    assert.match(card.code, /^[A-Z0-9]{6}$/);
    assert.match(card.code, /[A-Z]/);
    assert.match(card.code, /[0-9]/);
    assert.equal(card.totalUses, 20);
    assert.equal(card.note, "batch");
  }
  store.close();
});

test("login, usage success, fail, and idempotent success", () => {
  const store = makeStore();
  const [card] = store.createCards({ totalUses: 10, count: 1 });
  const login = store.loginCard(card.code);
  assert.equal(login.card.remainingUses, 10);

  const first = store.startUsage(login.token);
  let current = store.completeUsage(login.token, first.id, true);
  assert.equal(current.usedUses, 1);
  assert.equal(current.remainingUses, 9);
  current = store.completeUsage(login.token, first.id, true);
  assert.equal(current.usedUses, 1);

  const second = store.startUsage(login.token);
  current = store.completeUsage(login.token, second.id, false);
  assert.equal(current.usedUses, 1);
  assert.equal(current.remainingUses, 9);
  store.close();
});

test("disabled and exhausted cards cannot be used", () => {
  const store = makeStore();
  const [card] = store.createCards({ totalUses: 10, count: 1 });
  store.updateCard(card.code, { status: "disabled" });
  assert.throws(() => store.loginCard(card.code), HttpError);

  const [small] = store.createCards({ totalUses: 10, count: 1 });
  const login = store.loginCard(small.code);
  for (let index = 0; index < 10; index += 1) {
    const reservation = store.startUsage(login.token);
    store.completeUsage(login.token, reservation.id, true);
  }
  assert.throws(() => store.startUsage(login.token), HttpError);
  store.close();
});

test("last available use can only be reserved once", () => {
  const store = makeStore();
  const [card] = store.createCards({ totalUses: 10, count: 1 });
  const login = store.loginCard(card.code);
  for (let index = 0; index < 9; index += 1) {
    const reservation = store.startUsage(login.token);
    store.completeUsage(login.token, reservation.id, true);
  }
  store.startUsage(login.token);
  assert.throws(() => store.startUsage(login.token), HttpError);
  store.close();
});
