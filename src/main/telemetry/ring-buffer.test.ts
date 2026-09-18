import { describe, it, expect } from "vitest";
import { RingBuffer } from "./ring-buffer.js";

describe("RingBuffer", () => {
  it("stores items up to capacity", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.size).toBe(3);
    expect(buf.full).toBe(true);
    expect(buf.toArray()).toEqual([1, 2, 3]);
  });

  it("overwrites oldest on overflow", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4); // evicts 1
    expect(buf.size).toBe(3);
    expect(buf.toArray()).toEqual([2, 3, 4]);

    buf.push(5); // evicts 2
    expect(buf.toArray()).toEqual([3, 4, 5]);
  });

  it("preserves insertion order across wrap-around", () => {
    const buf = new RingBuffer<number>(4);
    for (let i = 1; i <= 10; i++) buf.push(i);
    // Only last 4 remain
    expect(buf.toArray()).toEqual([7, 8, 9, 10]);
  });

  it("returns empty array when empty", () => {
    const buf = new RingBuffer<string>(10);
    expect(buf.toArray()).toEqual([]);
    expect(buf.size).toBe(0);
    expect(buf.full).toBe(false);
  });

  it("recent() returns N most recent items", () => {
    const buf = new RingBuffer<number>(10);
    for (let i = 1; i <= 8; i++) buf.push(i);
    expect(buf.recent(3)).toEqual([6, 7, 8]);
    expect(buf.recent(100)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("clear() resets buffer", () => {
    const buf = new RingBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.toArray()).toEqual([]);
    buf.push(99);
    expect(buf.toArray()).toEqual([99]);
  });

  it("capacity 1 works correctly", () => {
    const buf = new RingBuffer<string>(1);
    buf.push("a");
    expect(buf.toArray()).toEqual(["a"]);
    buf.push("b");
    expect(buf.toArray()).toEqual(["b"]);
  });

  it("throws on capacity < 1", () => {
    expect(() => new RingBuffer(0)).toThrow();
    expect(() => new RingBuffer(-5)).toThrow();
  });

  it("handles partial fill without wrap", () => {
    const buf = new RingBuffer<number>(10);
    buf.push(1);
    buf.push(2);
    expect(buf.size).toBe(2);
    expect(buf.full).toBe(false);
    expect(buf.toArray()).toEqual([1, 2]);
  });
});