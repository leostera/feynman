import { expect, test } from "bun:test";
import { replay, scenarioDump, sessionFromRun } from "../../src/view/session";
import { runScenario } from "../../src/spec/index.ts";
import { parsePlaygroundUrlState, parseRoute, href, parseZoomLevel, writePlaygroundUrlState } from "../../src/view/url";
import remoteAccess from "../spec/fixtures/remote-access.ts";

const scenario = remoteAccess.scenarios[0];

test("scenario runs can be replayed exactly from their timeline operations", () => {
  const run = runScenario(remoteAccess, scenario);
  const session = sessionFromRun(run, scenario.name);
  expect(session.ops).not.toBeNull();
  const replayed = replay(remoteAccess, session.ops!, scenario.name);
  expect(replayed.steps.map(({ event }) => event?.key)).toEqual(session.steps.map(({ event }) => event?.key));
  expect(replayed.steps.map(({ world }) => world)).toEqual(session.steps.map(({ world }) => world));
  expect(scenarioDump(remoteAccess, session)).toMatchObject({
    request: expect.any(String),
    spec: remoteAccess.name,
    scenario: { operations: expect.arrayContaining([{ operation: "spawn", actor: "Person", label: "Alice" }]) },
  });
});

test("playground URLs round-trip scenario, speed, camera and custom state", () => {
  const query = new URLSearchParams({
    speed: "5",
    camera: JSON.stringify({ v: 2, zoom: 150000, x: -20000, y: 7000, fitScale: 800000, manual: true }),
    state: JSON.stringify([{ op: "spawn", actor: "Person", label: "Alice" }]),
  });
  const route = parseRoute(`#/playground/${encodeURIComponent("remote-access")}/${encodeURIComponent(scenario.name)}?${query}`, "fallback");
  expect(route).toMatchObject({ spec: "remote-access", page: "play", item: scenario.name });
  const state = parsePlaygroundUrlState(route.query);
  expect(state.speed).toBe(5);
  expect(state.camera).toEqual({ zoom: parseZoomLevel(150000)!, x: -20000, y: 7000, fitScale: 800000, manual: true });
  expect(state.ops).toEqual([{ op: "spawn", actor: "Person", label: "Alice" }]);
  const reorderedCamera = { zoom: state.camera.zoom, fitScale: state.camera.fitScale, manual: state.camera.manual, x: state.camera.x, y: state.camera.y };
  const cameraQuery = writePlaygroundUrlState(new URLSearchParams(), { ...state, camera: reorderedCamera }).get("camera")!;
  const serialized = JSON.parse(cameraQuery);
  expect(cameraQuery).toBe('{"v":2,"zoom":150000,"x":-20000,"y":7000,"fitScale":800000,"manual":true}');
  expect(serialized).toEqual({ v: 2, ...state.camera });
  expect([serialized.zoom, serialized.x, serialized.y, serialized.fitScale].every(Number.isSafeInteger)).toBe(true);
  const urlParams = new URLSearchParams({ camera: cameraQuery });
  const stableQuery = writePlaygroundUrlState(urlParams, parsePlaygroundUrlState(urlParams));
  expect(stableQuery.get("camera")).toBe(cameraQuery);
  expect(href(route)).toBe(`#/playground/remote-access/${encodeURIComponent(scenario.name)}?${query}`);
});

test("playground and flows have distinct route roots", () => {
  const playground = parseRoute("#/playground/remote-access/new", "fallback");
  const flows = parseRoute("#/flows/remote-access/Link%20a%20Mac%2F2", "fallback");
  expect(playground).toMatchObject({ page: "play", spec: "remote-access", item: "new" });
  expect(flows).toMatchObject({ page: "flows", spec: "remote-access", item: "Link a Mac/2" });
  expect(href(playground)).toBe("#/playground/remote-access/new");
  expect(href(flows)).toBe("#/flows/remote-access/Link%20a%20Mac%2F2");
});

test("legacy floating camera fields are normalized to integer units", () => {
  const state = parsePlaygroundUrlState(new URLSearchParams({ camera: JSON.stringify({ zoom: 98658, x: -5.622979999999984, y: -1.798279999999977, fitScale: 1, manual: true }) }));
  expect(state.camera).toEqual({ zoom: parseZoomLevel(98658)!, x: -5623, y: -1798, fitScale: 1000000, manual: true });
  expect(JSON.parse(writePlaygroundUrlState(new URLSearchParams(), state).get("camera")!)).toEqual({ v: 2, zoom: 98658, x: -5623, y: -1798, fitScale: 1000000, manual: true });
});

test("the layout choice round-trips, and auto stays out of the URL", () => {
  const vertical = parsePlaygroundUrlState(new URLSearchParams({ layout: "vertical" }));
  expect(vertical.layout).toBe("vertical");
  expect(writePlaygroundUrlState(new URLSearchParams(), vertical).get("layout")).toBe("vertical");
  const auto = writePlaygroundUrlState(new URLSearchParams({ layout: "horizontal" }), { ...vertical, layout: "auto" });
  expect(auto.has("layout")).toBe(false);
});

test("invalid URL state falls back to safe defaults", () => {
  const state = parsePlaygroundUrlState(new URLSearchParams({ speed: "999", camera: "{bad", state: "[null]", layout: "diagonal" }));
  expect(state).toEqual({ speed: 1, camera: { zoom: parseZoomLevel(100000)!, x: 0, y: 0, fitScale: null, manual: false }, layout: "auto", ops: null });
  const fractionalZoom = parsePlaygroundUrlState(new URLSearchParams({ camera: JSON.stringify({ zoom: 1.5, x: 0, y: 0, fitScale: null, manual: false }) }));
  expect(fractionalZoom.camera.zoom).toBe(parseZoomLevel(150000)!);
});
