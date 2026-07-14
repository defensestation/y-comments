// jsdom lacks elementsFromPoint; BlockNote's SideMenu calls it on mousemove.
if (typeof Document !== "undefined" && !Document.prototype.elementsFromPoint) {
  Document.prototype.elementsFromPoint = () => [];
}

// jsdom lacks CSS.escape; FloatingThread and ThreadsSidebar use it to build
// [data-thread-id] selectors. Thread ids are UUIDs, so quoting suffices.
if (typeof globalThis.CSS === "undefined") {
  (globalThis as Record<string, unknown>).CSS = {
    escape: (value: string) => value.replace(/["\\]/g, "\\$&"),
  };
}

// jsdom lacks ResizeObserver; floating-ui's autoUpdate observes the
// contextElement with it.
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
}
