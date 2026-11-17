// Coalesce camera, image-load and resize updates into one frame. Static views do no idle GPU work.
export function createRenderScheduler({ render, requestFrame = requestAnimationFrame, cancelFrame = cancelAnimationFrame }) {
  let pending = null;
  return {
    request() {
      if (pending !== null) return;
      pending = requestFrame((time) => {
        pending = null;
        render(time);
      });
    },
    cancel() {
      if (pending !== null) cancelFrame(pending);
      pending = null;
    },
  };
}
