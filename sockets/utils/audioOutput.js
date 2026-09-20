/**
 * Audio Output Utility
 * Manages speaker/earpiece routing for WebRTC audio/video calls
 * Instructions from GPT-5.6-Luna via Experiential Gateway
 */

/**
 * Apply audio output routing to a media element
 * @param {HTMLMediaElement} element - The audio or video element
 * @param {boolean} speakerEnabled - true = speaker (loud), false = earpiece/default
 * @returns {Promise<boolean>} - true if successfully applied, false if not supported
 */
export async function applyAudioOutput(element, speakerEnabled) {
  if (!element) {
    console.warn('[audioOutput] No element provided');
    return false;
  }

  // Check if setSinkId is supported (mainly Chromium-based browsers)
  if (typeof element.setSinkId !== 'function') {
    console.warn('[audioOutput] setSinkId not supported on this browser/device');
    return false;
  }

  try {
    // Get available audio output devices
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioOutputs = devices.filter(device => device.kind === 'audiooutput');

    if (audioOutputs.length === 0) {
      console.warn('[audioOutput] No audio output devices found');
      return false;
    }

    let targetDeviceId;

    const byLabel = (terms) =>
      audioOutputs.find((device) => {
        const label = device.label.toLowerCase();
        return terms.some((term) => label.includes(term));
      });

    if (speakerEnabled) {
      targetDeviceId = byLabel(['speaker', 'loudspeaker'])?.deviceId || 'default';
    } else {
      // Prefer the communications/receiver route. `default` can mean the
      // loudspeaker on desktop and on some mobile browsers, so it is not a
      // reliable earpiece choice by itself.
      targetDeviceId =
        byLabel(['communications', 'earpiece', 'receiver', 'headset'])?.deviceId ||
        'communications';
    }

    await element.setSinkId(targetDeviceId);
    console.log(`[audioOutput] Set to ${speakerEnabled ? 'speaker' : 'earpiece'} mode (device: ${targetDeviceId})`);
    return true;

  } catch (error) {
    console.error('[audioOutput] Failed to set audio output:', error);
    return false;
  }
}

/**
 * Check if audio output selection is supported on this device
 * @returns {boolean}
 */
export function isAudioOutputSupported() {
  if (typeof window === 'undefined') return false;
  
  // Check for setSinkId support
  const audioElement = document.createElement('audio');
  const supported = typeof audioElement.setSinkId === 'function';
  
  return supported;
}

/**
 * Get available audio output devices
 * @returns {Promise<Array>} Array of audio output devices
 */
export async function getAudioOutputDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(device => device.kind === 'audiooutput');
  } catch (error) {
    console.error('[audioOutput] Failed to enumerate devices:', error);
    return [];
  }
}

/**
 * Apply speaker setting to all remote media elements in a call
 * @param {NodeList|Array} elements - Collection of audio/video elements
 * @param {boolean} speakerEnabled - Speaker on/off
 */
export async function applyToAllElements(elements, speakerEnabled) {
  if (!elements || elements.length === 0) return;

  const results = await Promise.allSettled(
    Array.from(elements).map(el => applyAudioOutput(el, speakerEnabled))
  );

  const successCount = results.filter(r => r.status === 'fulfilled' && r.value).length;
  console.log(`[audioOutput] Applied to ${successCount}/${elements.length} elements`);
}
