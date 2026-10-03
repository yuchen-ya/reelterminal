import { act, renderHook, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTour, startTour, stopTour } from "./useTour";
import { ONBOARDING_KEY } from "./tour-steps";
import { DESKTOP_TOUR_STEPS } from "../../../desktop/editor/desktop-tour-steps";

beforeEach(() => {
  localStorage.removeItem(ONBOARDING_KEY);
  stopTour();
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  stopTour();
  vi.useRealTimers();
});

it("starts on first entry, remembers skip, and can be reopened", () => {
  const first = renderHook(() => useTour(DESKTOP_TOUR_STEPS));
  act(() => { vi.advanceTimersByTime(500); });
  expect(first.result.current.isActive).toBe(true);
  act(() => first.result.current.skip());
  first.unmount();
  const returning = renderHook(() => useTour(DESKTOP_TOUR_STEPS));
  act(() => { vi.advanceTimersByTime(500); });
  expect(returning.result.current.isActive).toBe(false);
  act(() => startTour());
  expect(returning.result.current.step.id).toBe("welcome");
  expect(returning.result.current.isActive).toBe(true);
});

it("completes the desktop export and collaboration steps and remembers completion", () => {
  const view = renderHook(() => useTour(DESKTOP_TOUR_STEPS));
  act(() => { vi.advanceTimersByTime(500); });
  act(() => view.result.current.goToStep(5));
  expect(view.result.current.step.id).toBe("agent-access");
  act(() => view.result.current.next());
  expect(view.result.current.step.id).toBe("export");
  act(() => view.result.current.next());
  expect(view.result.current.isLastStep).toBe(true);
  act(() => view.result.current.next());
  expect(view.result.current.isActive).toBe(false);
  expect(localStorage.getItem(ONBOARDING_KEY)).toBe("true");
});
