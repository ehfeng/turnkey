// Minimal canvas stand-in so model builders that draw procedural textures can run in Node for a smoke build.
// Drawing calls do nothing; the goal is to prove the builder runs and returns geometry, not to render it.
const noop = () => {};
function context2d(canvas) {
  const values = { canvas, font: '10px sans-serif', globalAlpha: 1 };
  return new Proxy(values, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'measureText') return (text) => ({ width: String(text).length * 6 });
      if (key === 'getImageData' || key === 'createImageData') {
        return (...args) => {
          const [w, h] = args.length >= 4 ? [args[2], args[3]] : [args[0]?.width ?? args[0], args[0]?.height ?? args[1]];
          return { width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) };
        };
      }
      if (/^create(Linear|Radial|Conic)Gradient$/.test(key)) return () => ({ addColorStop: noop });
      if (key === 'createPattern') return () => ({ setTransform: noop });
      if (key === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      return noop;
    },
    set(target, key, value) { target[key] = value; return true; },
  });
}

function makeElement(tag) {
  const element = {
    tagName: String(tag).toUpperCase(), width: 300, height: 150, style: {},
    setAttribute: noop, appendChild: noop, addEventListener: noop, removeEventListener: noop,
    toDataURL: () => 'data:,',
  };
  element.getContext = (type) => (type === '2d' ? (element._ctx ??= context2d(element)) : null);
  return element;
}

export function installDomStub() {
  if (globalThis.document) return;
  globalThis.document = {
    createElement: makeElement,
    createElementNS: (_ns, tag) => makeElement(tag),
    documentElement: { style: {} },
  };
  globalThis.OffscreenCanvas ??= class { constructor(w, h) { return Object.assign(makeElement('canvas'), { width: w, height: h }); } };
}
