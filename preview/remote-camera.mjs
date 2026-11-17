// Follow the newest confirmed pose. One target bounds both lag and memory when packets
// arrive in bursts. A quiet stream ends exactly at its final pose and stops requesting frames.
import { Spherical, Vector3 } from 'three';

const FOLLOW_MS = 55;
const SETTLE_MS = 240;
const turn = 2 * Math.PI;

export function createRemoteCameraMotion() {
  const focus = new Vector3();
  const offset = new Vector3();
  const currentOrbit = new Spherical();
  const nextOrbit = new Spherical();
  let target, previousTime, settleAt;

  return {
    get active() { return Boolean(target); },
    set(view, time) {
      if (!target) previousTime = time;
      target = view;
      settleAt = time + SETTLE_MS;
    },
    clear() { target = undefined; },
    step(camera, controls, aspect, time) {
      if (!target) return false;
      const final = time >= settleAt;
      const elapsed = Math.max(0, time - previousTime);
      // Shorten the exponential tail into a linear arrival during the last time constant.
      const blend = final ? 1 : Math.max(-Math.expm1(-elapsed / FOLLOW_MS), elapsed / (settleAt - previousTime));
      previousTime = Math.max(time, previousTime);
      focus.fromArray(target.target);
      if (final) {
        controls.target.copy(focus);
        camera.position.fromArray(target.position);
      } else {
        // Follow the shortest orbit around the focus. A straight interpolation of camera
        // positions can take a shortcut through the model during a large orbit or a drop.
        currentOrbit.setFromVector3(offset.subVectors(camera.position, controls.target));
        nextOrbit.setFromVector3(offset.fromArray(target.position).sub(focus));
        const angle = (nextOrbit.theta - currentOrbit.theta + 1.5 * turn) % turn - Math.PI;
        currentOrbit.theta += angle * blend;
        currentOrbit.phi += (nextOrbit.phi - currentOrbit.phi) * blend;
        currentOrbit.radius += (nextOrbit.radius - currentOrbit.radius) * blend;
        controls.target.lerp(focus, blend);
        camera.position.copy(controls.target).add(offset.setFromSpherical(currentOrbit));
      }
      if (camera.isOrthographicCamera && Number.isFinite(target.planHeight) && target.planHeight > 0) {
        const currentHeight = camera.top - camera.bottom;
        const height = final ? target.planHeight : currentHeight + (target.planHeight - currentHeight) * blend;
        camera.top = height / 2; camera.bottom = -camera.top;
        camera.left = -camera.top * aspect; camera.right = camera.top * aspect;
      }
      if (Number.isFinite(target.zoom) && target.zoom > 0) {
        camera.zoom = final ? target.zoom : camera.zoom + (target.zoom - camera.zoom) * blend;
      }
      camera.updateProjectionMatrix();
      controls.update();
      if (final) target = undefined;
      return !final;
    },
  };
}
