// HTTP-level gates for the publisher adapter (no database): batch delivery with the service secret,
// dedupe by CloudEvent id, retry exactly once on retryable failures, no retry on a 4xx, bounded by timeout.
import { afterEach, describe, expect, test } from "vitest";
import { BATCH_CONTENT_TYPE, createHttpPublisher, SERVICE_SECRET_HEADER } from "../src/commit/publisher-http.ts";
import { deadUrl, exactlyOnce, startRecorder, type Recorder } from "./publisher-recorder.ts";

const SECRET = "test-secret-not-a-real-one";
const ev = (i: number) => ({ id: `00000000-0000-7000-8000-${String(i).padStart(12, "0")}`, munimrun: `h.p.s${i}`, type: "munim.x.y.z.v1" });
let rec: Recorder | undefined;
afterEach(async () => {
  await rec?.close();
  rec = undefined;
});

function countingFetch() {
  const calls = { n: 0 };
  const f: typeof fetch = (input, init) => {
    calls.n++;
    return fetch(input, init);
  };
  return { calls, f };
}

describe("publisher-http", () => {
  test("a batch of 20 → one POST to /events, each id once, secret header and batch content type set", async () => {
    rec = await startRecorder();
    const events = [...Array(20).keys()].map(ev);
    await createHttpPublisher({ url: rec.url, serviceSecret: SECRET }).publish(events);
    expect(rec.requests).toHaveLength(1);
    expect(rec.requests[0]).toMatchObject({ path: "/events", secret: SECRET, contentType: BATCH_CONTENT_TYPE });
    expect(rec.requests[0]!.events.map((e) => e.munimrun)).toEqual(events.map((e) => e.munimrun));
    expect(exactlyOnce(events.map((e) => e.id), rec.received)).toEqual([]);
    expect(SERVICE_SECRET_HEADER).toBe("x-munim-service-secret");
  });

  test("duplicate ids in one batch are sent once", async () => {
    rec = await startRecorder();
    await createHttpPublisher({ url: rec.url, serviceSecret: SECRET }).publish([ev(1), ev(1), ev(2)]);
    expect(rec.requests[0]!.ids).toEqual([ev(1).id, ev(2).id]);
  });

  test("503 then 202 → retried once and resolves (the first copy was received: at-least-once)", async () => {
    rec = await startRecorder({ failFirst: 1 });
    await createHttpPublisher({ url: rec.url, serviceSecret: SECRET }).publish([ev(1)]);
    expect(rec.requests).toHaveLength(2);
    expect(rec.received.get(ev(1).id)).toBe(2);
  });

  test("503 twice → rejects after exactly 2 attempts", async () => {
    rec = await startRecorder({ failFirst: 5 });
    await expect(createHttpPublisher({ url: rec.url, serviceSecret: SECRET }).publish([ev(1)])).rejects.toThrow("HTTP 503");
    expect(rec.requests).toHaveLength(2);
  });

  test("400 → rejects without retrying", async () => {
    rec = await startRecorder({ status: 400 });
    await expect(createHttpPublisher({ url: rec.url, serviceSecret: SECRET }).publish([ev(1)])).rejects.toThrow("HTTP 400");
    expect(rec.requests).toHaveLength(1);
  });

  test("nothing listening → rejects after 2 attempts; hung endpoint → rejects on timeout after 2 attempts", async () => {
    const down = countingFetch();
    await expect(createHttpPublisher({ url: await deadUrl(), serviceSecret: SECRET, fetch: down.f }).publish([ev(1)])).rejects.toThrow("not delivered");
    expect(down.calls.n).toBe(2);
    rec = await startRecorder({ hang: true });
    const t0 = Date.now();
    await expect(createHttpPublisher({ url: rec.url, serviceSecret: SECRET, timeoutMs: 200 }).publish([ev(1)])).rejects.toThrow("TimeoutError");
    expect(rec.requests).toHaveLength(2);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test("an empty batch sends nothing", async () => {
    rec = await startRecorder();
    await createHttpPublisher({ url: rec.url, serviceSecret: SECRET }).publish([]);
    expect(rec.requests).toHaveLength(0);
  });
});
