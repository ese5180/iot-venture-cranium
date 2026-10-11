/**
 * Where a board is with a deployment.
 *
 * Two sources describe it. The job execution in AWS IoT Jobs decides every outcome: it
 * is the record AWS keeps, and a board can only move it forward. The board's shadow
 * adds what the execution does not carry: that the board is waiting for its button,
 * which step of an update it is in, and how far the download is. The shadow is used
 * only while it names this deployment (ota.job), and only for display.
 *
 *   QUEUED       waiting_for_device, or waiting_for_button once the board is online
 *                and says that it holds this deployment
 *   IN_PROGRESS  downloading -> verifying -> rebooting -> testing
 *   SUCCEEDED    succeeded
 *   FAILED       rolled_back when the board says the bootloader went back, else failed
 *   REJECTED     declined when someone said no on the board, else refused
 *   CANCELED     cancelled        TIMED_OUT  timed_out        REMOVED  removed
 *
 * A board says "downloading" from the moment its button is pressed, which is a moment
 * before AWS has accepted that the update starts. Until AWS has, the execution is
 * queued and the phase stays waiting_for_button: the execution, not the shadow, says
 * whether an update has started, and a phase never goes back to waiting_for_device
 * once the board holds the offer.
 */

const STEPS = Object.freeze(['downloading', 'verifying', 'rebooting', 'testing']);

/**
 * @param {object} input
 * @param {string} input.status         execution status from AWS IoT Jobs
 * @param {string|null} [input.reason]  statusDetails.reason, already sanitized
 * @param {string|null} [input.step]    statusDetails.step, already sanitized
 * @param {string} input.jobId          the deployment this execution belongs to
 * @param {object|null} [input.device]  the board as lib/shadow.mjs describes it
 * @returns {{ phase: string, progress: number|null }}
 */
export function deriveTimeline({ status, reason = null, step = null, jobId, device = null }) {
  const ota = device?.ota ?? null;
  const tracking = ota !== null && ota.job === jobId;

  switch (status) {
    case 'QUEUED': {
      // Any state but idle: the board has picked the offer up.
      const holding = device?.online === true && tracking && ota.state !== 'idle';
      return { phase: holding ? 'waiting_for_button' : 'waiting_for_device', progress: null };
    }
    case 'IN_PROGRESS': {
      // The execution names the step the board announced to AWS; the shadow may be a
      // step further, or lag behind. An update only moves forward: take the later one.
      const announced = step === 'rebooting' ? 'rebooting' : 'downloading';
      const live = tracking && STEPS.includes(ota.state) ? ota.state : null;
      const phase = live !== null && STEPS.indexOf(live) > STEPS.indexOf(announced) ? live : announced;
      return { phase, progress: live === phase ? ota.progress : null };
    }
    case 'SUCCEEDED':
      return { phase: 'succeeded', progress: null };
    case 'FAILED':
      return { phase: reason === 'rolled_back' ? 'rolled_back' : 'failed', progress: null };
    case 'REJECTED':
      return { phase: reason === 'declined' ? 'declined' : 'refused', progress: null };
    case 'CANCELED':
      return { phase: 'cancelled', progress: null };
    case 'TIMED_OUT':
      return { phase: 'timed_out', progress: null };
    case 'REMOVED':
      return { phase: 'removed', progress: null };
    default:
      throw new RangeError(`Unknown execution status ${String(status)}`);
  }
}
