import assert from "node:assert/strict";
import type { WebviewToHost } from "../src/shared/ipc";

// 用假时钟驱真实 bridge；不用等后台计时器，也不用连 DSH。
class ClockWindow extends EventTarget {
  private now = 0;
  private nextId = 0;
  private readonly timers = new Map<number, { at: number; every: number; run: () => void }>();

  setTimeout = (run: () => void, ms: number) => this.add(run, ms, 0);
  setInterval = (run: () => void, ms: number) => this.add(run, ms, ms);
  clearTimeout = (id: number) => { this.timers.delete(id); };
  clearInterval = this.clearTimeout;

  private add(run: () => void, ms: number, every: number): number {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.now + ms, every, run });
    return id;
  }

  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      const [id, timer] = next;
      this.now = timer.at;
      if (timer.every) timer.at += timer.every;
      else this.timers.delete(id);
      timer.run();
    }
    this.now = end;
  }
}

class Visibility extends EventTarget {
  hidden = true;
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

const window = new ClockWindow();
const document = new Visibility();
const sent: WebviewToHost[] = [];
Object.assign(globalThis, {
  window,
  document,
  acquireVsCodeApi: () => ({ postMessage: (message: WebviewToHost) => sent.push(message) }),
});
const { postUserAction, watchHostConnection, onHostFrame, subscribe } = await import("../src/webview/bridge");
const states: boolean[] = [];
let frames = 0;
let reducer = 0;
onHostFrame(() => { frames++; });
subscribe(() => { reducer++; });
const stop = watchHostConnection((blocked) => states.push(blocked));
const pings = () => sent.filter((message) => message.type === "view/ping");
const ping = () => {
  const message = pings().at(-1);
  assert.ok(message);
  return message.id;
};
const reply = (id: number) => window.dispatchEvent(new MessageEvent("message", { data: { type: "view/pong", id } }));

window.advance(10000);
assert.deepEqual(sent, [], "hidden views do not probe");
document.setHidden(false);
const first = ping();
window.dispatchEvent(new Event("focus"));
assert.equal(sent.length, 1, "visibility and focus do not duplicate in-flight pings");
window.advance(2999);
assert.equal(sent.length, 1, "faster polling never replaces an in-flight probe");
assert.deepEqual(states, [], "a slow host still gets the full three seconds");
reply(first);
window.advance(1);
assert.deepEqual(states, [false], "a reply just before the deadline avoids the hint");
assert.equal(frames + reducer, 0, "pongs never reach frame observers or the reducer");

postUserAction({ type: "newSession" });
const second = ping();
assert.notEqual(second, first, "a toolbar action probes immediately, before the next poll");
postUserAction({ type: "listTrajectory" });
assert.equal(pings().length, 2, "repeated actions share the same in-flight probe");
assert.deepEqual(sent.map((message) => message.type), ["view/ping", "newSession", "view/ping", "listTrajectory"],
  "actions are sent immediately and are not replayed by the watchdog");
reply(first);
window.advance(2999);
assert.deepEqual(states, [false], "wait for the full timeout");
window.advance(1);
assert.deepEqual(states, [false, true], "a lost host surfaces the hint three seconds after the action");

window.advance(2000);
const third = ping();
assert.notEqual(third, second, "a visible tab retries within two seconds");
reply(second);
assert.deepEqual(states, [false, true], "a superseded reply cannot clear the hint");
reply(third);
assert.deepEqual(states, [false, true, false], "the hint clears once the host responds again");

window.advance(1999);
assert.equal(ping(), third);
window.advance(1);
const fourth = ping();
assert.notEqual(fourth, third, "a visible tab probes every two seconds when idle");
window.advance(2600);
window.dispatchEvent(new MessageEvent("message", { data: { type: "connection", status: "offline" } }));
window.advance(400);
assert.ok(!states.slice(3).includes(true), "ordinary host traffic proves liveness even if DSH is offline");
assert.equal(frames, 1);
assert.equal(reducer, 1);

window.advance(1000);
const fifth = ping();
assert.notEqual(fifth, fourth);
document.setHidden(true);
postUserAction({ type: "openInBrowser" });
reply(fifth);
window.advance(6000);
assert.equal(ping(), fifth, "hide cancels the deadline and stops traffic");
assert.ok(!states.slice(3).includes(true));
document.setHidden(false);
assert.notEqual(ping(), fifth, "show rechecks immediately");
stop();
const finalCount = pings().length;
reply(ping());
document.setHidden(true);
document.setHidden(false);
window.dispatchEvent(new Event("focus"));
postUserAction({ type: "newSession" });
window.advance(10000);
assert.equal(pings().length, finalCount, "cleanup unregisters timers and event listeners");
assert.ok(!states.slice(3).includes(true));
console.log("viewHostConnection: all assertions passed");
