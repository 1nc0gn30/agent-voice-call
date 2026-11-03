/**
 * Zoth Sovereign Live Voice Call Engine.
 * Dual-Rail Audio Engine • Web Audio API (decodeAudioData) • 60fps Pantheon Orb
 * Live Text Streaming into Input Field • 8s Silence VAD Auto-Send • Enter Key to Send
 * HTTPS Auto-Upgrade for Mobile Microphones • Echo-Guarded Full-Duplex Loop
 */

(function () {
  'use strict';

  // 1. Session & Parameters
  const urlParams = new URLSearchParams(window.location.search);
  let token = urlParams.get('token') || '';
  const channel = urlParams.get('channel') || 'signal';

  // HTTPS Auto-Upgrade for Tailscale on mobile devices (Guarantees Web Speech API permissions)
  if (window.location.protocol === 'http:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    const targetHttps = `https://zoth-pill.tailb0828c.ts.net/call?token=${encodeURIComponent(token)}&channel=${encodeURIComponent(channel)}`;
    window.location.replace(targetHttps);
    return;
  }

  // DOM Elements
  const elStatus = document.getElementById('connectionStatus');
  const elTimer = document.getElementById('callTimer');
  const elChannel = document.getElementById('channelBadge');
  const elPersonaName = document.getElementById('personaName');
  const elPersonaRole = document.getElementById('personaRole');
  const elLiveAgentText = document.getElementById('liveAgentText');
  const elLiveUserText = document.getElementById('liveUserText');
  const elUserLiveBubble = document.getElementById('userLiveBubble');
  const elUserSpeechIndicator = document.getElementById('userSpeechIndicator');
  const elTranscriptViewport = document.getElementById('transcriptViewport');
  const elBtnMic = document.getElementById('btnMic');
  const elMicIcon = document.getElementById('micIcon');
  const elBtnVoice = document.getElementById('btnVoiceSelector');
  const elLblVoice = document.getElementById('lblVoice');
  const elBtnEndCall = document.getElementById('btnEndCall');
  const elBtnTestSpeaker = document.getElementById('btnTestSpeaker');
  const elUnmuteBanner = document.getElementById('unmuteBanner');
  const elBtnUnmuteTap = document.getElementById('btnUnmuteTap');
  const elJoinOverlay = document.getElementById('joinOverlay');
  const elBtnJoinCall = document.getElementById('btnJoinCall');
  const elJoinVoiceName = document.getElementById('joinVoiceName');
  const elInputFallBackText = document.getElementById('inputFallBackText');
  const elBtnSendFallBack = document.getElementById('btnSendFallBack');
  const elBtnReplayInitial = document.getElementById('btnReplayInitial');
  const elModal = document.getElementById('endModal');
  const elModalDuration = document.getElementById('modalDuration');
  const elModalDebrief = document.getElementById('modalDebriefText');
  const canvas = document.getElementById('orbCanvas');
  const ctx = canvas.getContext('2d');

  // Audio & State
  let currentVoice = 'azoth';
  const voicesList = ['azoth', 'ghostbyte', 'athena', 'mercury', 'kitsune', 'chronos'];
  const voiceRoles = {
    azoth: 'Sovereign Strategic Intelligence',
    ghostbyte: 'Imperator & Enclave Commander',
    athena: 'Classical Logic & Systems Architect',
    mercury: 'Tactical Recon & Fast Dispatcher',
    kitsune: 'Adaptive Synthesis & Companion',
    chronos: 'Measured, Deep, Stoic Architect'
  };

  // State Machine Flags
  let recognition = null;
  let isListening = false;
  let isAgentSpeaking = false;
  let isProcessingUtterance = false;
  let isRecognitionStarting = false;
  let recognitionRestartTimer = null;
  let callStartTime = null;
  let timerInterval = null;
  let audioUnlocked = false;
  let pendingAudio = null;

  // Voice Activity Detection & Silence Timer (8-second auto-send as requested)
  let activeUserSpeech = '';
  let speechSilenceTimer = null;
  let countdownTimer = null;
  let countdownSecondsLeft = 8;
  const SILENCE_TIMEOUT_MS = 8000; // 8 seconds of quiet triggers auto-send

  // Store turn audio history for replay
  const turnAudioMap = new Map();

  // 2. Web Audio API Engine for Agent Audio Playback
  let audioCtx = null;
  let gainNode = null;
  let analyserNode = null;
  let currentSourceNode = null;
  let fallbackAudioPlayer = new Audio();
  const freqData = new Uint8Array(64);

  function getAudioContext() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        audioCtx = new AudioContextClass();
        gainNode = audioCtx.createGain();
        gainNode.gain.value = 1.15; // Clean amplification for mobile/laptop speakers

        // Dynamics compressor to prevent distortion
        try {
          const compressor = audioCtx.createDynamicsCompressor();
          compressor.threshold.setValueAtTime(-24, audioCtx.currentTime);
          compressor.knee.setValueAtTime(30, audioCtx.currentTime);
          compressor.ratio.setValueAtTime(10, audioCtx.currentTime);
          compressor.attack.setValueAtTime(0.003, audioCtx.currentTime);
          compressor.release.setValueAtTime(0.25, audioCtx.currentTime);

          analyserNode = audioCtx.createAnalyser();
          analyserNode.fftSize = 128;
          analyserNode.smoothingTimeConstant = 0.75;

          gainNode.connect(compressor);
          compressor.connect(analyserNode);
          analyserNode.connect(audioCtx.destination);
        } catch (e) {
          gainNode.connect(audioCtx.destination);
        }
      }
    }
    return audioCtx;
  }

  async function unlockAudio() {
    if (audioUnlocked) return;
    const c = getAudioContext();
    if (c && c.state === 'suspended') {
      try {
        await c.resume();
      } catch (e) {
        console.warn('AudioContext resume error:', e);
      }
    }

    // Play subtle 432Hz sine chime to warm up audio hardware
    try {
      if (c) {
        const osc = c.createOscillator();
        const g = c.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(432, c.currentTime);
        g.gain.setValueAtTime(0.08, c.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.12);
        osc.connect(g);
        g.connect(c.destination);
        osc.start();
        osc.stop(c.currentTime + 0.12);
      }
    } catch (e) {}

    // Unlock HTML5 Audio
    try {
      fallbackAudioPlayer.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAP8A/w==';
      const p = fallbackAudioPlayer.play();
      if (p !== undefined) {
        p.then(() => { fallbackAudioPlayer.pause(); }).catch(() => {});
      }
    } catch (e) {}

    audioUnlocked = true;
    hideUnmuteBanner();
  }

  // 3. 60fps Golden / Emerald Pantheon Orb Visualization
  let orbPhase = 0;
  let orbIntensity = 0.2; // 0.0 to 1.0

  function renderOrb() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;

    // 1. Read Frequency Data if Agent is Speaking
    if (isAgentSpeaking && analyserNode) {
      try {
        analyserNode.getByteFrequencyData(freqData);
        let sum = 0;
        for (let i = 0; i < freqData.length; i++) sum += freqData[i];
        const avg = sum / freqData.length;
        orbIntensity = Math.min(1.0, 0.25 + (avg / 128) * 0.75);
      } catch (e) {}
      orbPhase += 0.07;
    } else if (isProcessingUtterance) {
      orbPhase += 0.08;
      orbIntensity = 0.5 + Math.sin(orbPhase * 3) * 0.25;
    } else {
      orbPhase += isListening ? 0.03 : 0.015;
      if (orbIntensity > 0.2) orbIntensity -= 0.015;
    }

    const baseRadius = 68 + Math.sin(orbPhase * 2) * 5;
    const pulseBoost = orbIntensity * 28;

    // Outer Glow Aura
    const grad = ctx.createRadialGradient(cx, cy, baseRadius * 0.35, cx, cy, baseRadius + pulseBoost + 45);
    if (isAgentSpeaking) {
      grad.addColorStop(0, 'rgba(212, 175, 55, 0.9)');
      grad.addColorStop(0.5, 'rgba(212, 175, 55, 0.35)');
      grad.addColorStop(1, 'rgba(212, 175, 55, 0)');
    } else if (isListening) {
      grad.addColorStop(0, 'rgba(16, 185, 129, 0.85)');
      grad.addColorStop(0.5, 'rgba(16, 185, 129, 0.35)');
      grad.addColorStop(1, 'rgba(16, 185, 129, 0)');
    } else {
      grad.addColorStop(0, 'rgba(212, 175, 55, 0.35)');
      grad.addColorStop(1, 'rgba(8, 8, 11, 0)');
    }
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, baseRadius + pulseBoost + 45, 0, Math.PI * 2);
    ctx.fill();

    // Central Core Sphere
    ctx.beginPath();
    ctx.arc(cx, cy, baseRadius + pulseBoost, 0, Math.PI * 2);
    ctx.fillStyle = isAgentSpeaking ? '#D4AF37' : (isListening ? '#10B981' : '#1A1A28');
    ctx.shadowBlur = isAgentSpeaking ? 28 : (isListening ? 22 : 10);
    ctx.shadowColor = isAgentSpeaking ? '#D4AF37' : (isListening ? '#10B981' : 'rgba(212,175,55,0.4)');
    ctx.fill();
    ctx.shadowBlur = 0;

    // Harmonic Waveform Rings
    const ringCount = 3;
    for (let i = 0; i < ringCount; i++) {
      ctx.beginPath();
      const r = baseRadius + 18 * (i + 1) + Math.sin(orbPhase + i * 1.5) * 6;
      ctx.arc(cx, cy, Math.max(10, r), 0, Math.PI * 2);
      ctx.strokeStyle = isAgentSpeaking ? 'rgba(255, 235, 150, 0.55)' : (isListening ? 'rgba(16, 185, 129, 0.45)' : 'rgba(212, 175, 55, 0.2)');
      ctx.lineWidth = 1.75;
      ctx.setLineDash([8 + i * 4, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    requestAnimationFrame(renderOrb);
  }

  // 4. Call Timer
  function startCallTimer() {
    if (timerInterval) return;
    callStartTime = Date.now();
    timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
      const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const s = String(elapsed % 60).padStart(2, '0');
      elTimer.textContent = `${m}:${s}`;
    }, 1000);
  }

  // 5. Web Speech API (Microphone Recognition) with Live Input Streaming & 8s VAD
  function setupSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      elStatus.textContent = 'MIC MANUAL (TYPE BELOW & HIT ENTER)';
      return;
    }

    try {
      if (recognition) recognition.abort();
    } catch (e) {}

    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      isRecognitionStarting = false;
      isListening = true;
      elBtnMic.classList.add('active');
      elBtnMic.classList.remove('muted');
      if (!isAgentSpeaking && !isProcessingUtterance) {
        elStatus.textContent = activeUserSpeech ? '🎙️ LISTENING (SPEAKING...)' : '🎙️ LISTENING • SPEAK NATURALLY';
      }
    };

    recognition.onsoundstart = () => {
      orbIntensity = 0.85;
      elBtnMic.style.transform = 'scale(1.15)';
      elBtnMic.style.boxShadow = '0 0 35px rgba(16, 185, 129, 0.8)';
    };

    recognition.onspeechstart = () => {
      orbIntensity = 0.95;
      if (elUserSpeechIndicator) {
        elUserSpeechIndicator.textContent = '● SPEAKING (LIVE)';
        elUserSpeechIndicator.style.color = '#10B981';
      }
      resetSilenceCountdown();
    };

    recognition.onspeechend = () => {
      elBtnMic.style.transform = 'scale(1)';
      elBtnMic.style.boxShadow = '0 0 25px rgba(16, 185, 129, 0.4)';
    };

    recognition.onsoundend = () => {
      elBtnMic.style.transform = 'scale(1)';
    };

    recognition.onresult = (event) => {
      if (isAgentSpeaking || isProcessingUtterance) return;

      let currentFinal = '';
      let currentInterim = '';

      for (let i = 0; i < event.results.length; ++i) {
        const transcriptPiece = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          currentFinal += transcriptPiece + ' ';
        } else {
          currentInterim += transcriptPiece;
        }
      }

      const fullSpokenText = (currentFinal + currentInterim).trim();
      if (fullSpokenText) {
        activeUserSpeech = fullSpokenText;

        // STREAM LIVE INTO INPUT AREA AS USER TALKS!
        if (elInputFallBackText) {
          elInputFallBackText.value = fullSpokenText;
          elInputFallBackText.scrollLeft = elInputFallBackText.scrollWidth;
        }

        // Also update live bubble preview
        elUserLiveBubble.style.display = 'block';
        elLiveUserText.textContent = `"${fullSpokenText}"`;

        orbIntensity = 0.85;
        resetSilenceCountdown();
      }
    };

    recognition.onerror = (e) => {
      console.warn('Speech recognition status:', e.error);
      isRecognitionStarting = false;
      if (e.error === 'not-allowed') {
        elStatus.textContent = 'MIC PERMISSION DENIED (CHECK BROWSER)';
        elBtnMic.classList.add('muted');
      } else if (e.error === 'no-speech') {
        // Natural silence interval, ignore
      }
    };

    recognition.onend = () => {
      isRecognitionStarting = false;
      clearTimeout(recognitionRestartTimer);

      // Auto-restart recognition only if call is active and NOT currently processing or speaking
      if (isListening && !isAgentSpeaking && !isProcessingUtterance) {
        recognitionRestartTimer = setTimeout(() => {
          safeStartRecognition();
        }, 250);
      }
    };

    safeStartRecognition();
  }

  function resetSilenceCountdown() {
    clearTimeout(speechSilenceTimer);
    clearInterval(countdownTimer);
    countdownSecondsLeft = 8;

    if (elUserSpeechIndicator) {
      elUserSpeechIndicator.textContent = `● WAITING (${countdownSecondsLeft}s) • HIT ENTER TO SEND`;
      elUserSpeechIndicator.style.color = '#F59E0B';
    }

    countdownTimer = setInterval(() => {
      countdownSecondsLeft -= 1;
      if (countdownSecondsLeft > 0) {
        if (elUserSpeechIndicator && activeUserSpeech) {
          elUserSpeechIndicator.textContent = `● WAITING (${countdownSecondsLeft}s) • HIT ENTER TO SEND`;
        }
        elStatus.textContent = `LISTENING... (AUTO-SEND IN ${countdownSecondsLeft}s OR HIT ENTER ⏎)`;
      } else {
        clearInterval(countdownTimer);
      }
    }, 1000);

    speechSilenceTimer = setTimeout(() => {
      clearInterval(countdownTimer);
      finalizeAndSendUtterance();
    }, SILENCE_TIMEOUT_MS);
  }

  function safeStartRecognition() {
    if (!recognition || isRecognitionStarting || isAgentSpeaking || isProcessingUtterance) return;
    try {
      isRecognitionStarting = true;
      recognition.start();
    } catch (e) {
      isRecognitionStarting = false;
    }
  }

  function safeStopRecognition() {
    if (!recognition) return;
    try {
      recognition.stop();
    } catch (e) {}
  }

  // 6. Natural Turn Finalizer & Send Dispatcher
  function finalizeAndSendUtterance() {
    clearTimeout(speechSilenceTimer);
    clearInterval(countdownTimer);

    // Read whatever is in the input box or activeUserSpeech
    const textToSend = (elInputFallBackText ? elInputFallBackText.value : activeUserSpeech).trim();
    if (!textToSend || isProcessingUtterance || isAgentSpeaking) return;

    activeUserSpeech = '';
    if (elInputFallBackText) elInputFallBackText.value = '';
    isProcessingUtterance = true;
    safeStopRecognition();
    sendUtteranceToAgent(textToSend);
  }

  // 7. Send Utterance to Agent Backend
  async function sendUtteranceToAgent(text) {
    clearTimeout(speechSilenceTimer);
    clearInterval(countdownTimer);
    isProcessingUtterance = true;
    safeStopRecognition(); // Pause mic during backend generation

    elStatus.textContent = '⚡ AGENT THINKING...';
    if (elUserSpeechIndicator) {
      elUserSpeechIndicator.textContent = '⚡ PROCESSING';
      elUserSpeechIndicator.style.color = '#D4AF37';
    }
    elUserLiveBubble.style.display = 'block';
    elLiveUserText.textContent = `"${text}" ✓`;

    try {
      const res = await fetch('/api/call/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token, text: text, voice: currentVoice })
      });

      if (!res.ok) {
        throw new Error('Server error: ' + res.status);
      }

      const data = await res.json();
      isProcessingUtterance = false;
      elStatus.textContent = `🔊 ${currentVoice.toUpperCase()} SPEAKING (${data.latency_ms || 0}ms)`;
      elLiveAgentText.textContent = `"${data.reply_text}"`;

      // Append bubble to transcript feed
      appendAgentBubble(data.reply_text, data.audio_base64, data.audio_mime || 'audio/wav', data.latency_ms);

      // Play synthesized audio
      if (data.audio_base64) {
        await playAgentAudio(data.audio_base64, data.audio_mime || 'audio/wav', data.reply_text);
      } else {
        fallbackBrowserTTS(data.reply_text);
      }
    } catch (err) {
      console.error('Failed sending utterance:', err);
      isProcessingUtterance = false;
      elStatus.textContent = 'ERROR • RECONNECTING';
      resumeListening();
    }
  }

  // 8. Dual-Rail Audio Playback Engine (Echo-Guarded)
  async function playAgentAudio(b64Data, mime = 'audio/wav', replyText = '') {
    isAgentSpeaking = true;
    isProcessingUtterance = false;
    safeStopRecognition(); // Strictly stop mic while speaker is playing to prevent acoustic echo!

    orbIntensity = 0.95;
    elBtnMic.classList.add('speaking');
    elStatus.textContent = '🔊 AGENT SPEAKING';

    const c = getAudioContext();
    if (c && c.state === 'suspended') {
      try {
        await c.resume();
      } catch (e) {}
    }

    const onAudioPlaybackComplete = () => {
      isAgentSpeaking = false;
      currentSourceNode = null;
      elBtnMic.classList.remove('speaking');
      elStatus.textContent = 'CALL ACTIVE • LISTENING';
      if (elUserSpeechIndicator) {
        elUserSpeechIndicator.textContent = '● LIVE';
        elUserSpeechIndicator.style.color = '#10B981';
      }
      // Acoustic buffer: wait 250ms for room echo to dissipate before unmuting mic
      setTimeout(() => {
        resumeListening();
      }, 250);
    };

    try {
      // Decode Base64 to ArrayBuffer
      const binaryStr = atob(b64Data);
      const len = binaryStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      // RAIL 1: Web Audio API (decodeAudioData)
      if (c) {
        try {
          const bufferCopy = bytes.buffer.slice(0);
          const audioBuffer = await c.decodeAudioData(bufferCopy);

          if (currentSourceNode) {
            try { currentSourceNode.stop(); } catch (e) {}
          }

          const source = c.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(gainNode || c.destination);
          currentSourceNode = source;

          source.onended = onAudioPlaybackComplete;

          source.start(0);
          hideUnmuteBanner();
          return;
        } catch (webAudioErr) {
          console.warn('Web Audio decode failed, falling to Blob URL:', webAudioErr);
        }
      }

      // RAIL 2: HTML5 Audio with Blob URL
      const blob = new Blob([bytes], { type: mime });
      const blobUrl = URL.createObjectURL(blob);
      fallbackAudioPlayer.src = blobUrl;

      fallbackAudioPlayer.onended = () => {
        URL.revokeObjectURL(blobUrl);
        onAudioPlaybackComplete();
      };

      fallbackAudioPlayer.onerror = (e) => {
        console.warn('HTML Audio play error, falling to browser TTS:', e);
        URL.revokeObjectURL(blobUrl);
        fallbackBrowserTTS(replyText);
      };

      const p = fallbackAudioPlayer.play();
      if (p !== undefined) {
        p.then(() => {
          hideUnmuteBanner();
        }).catch(err => {
          console.warn('Autoplay blocked by browser policy:', err);
          showUnmuteBanner(b64Data, mime, replyText, blobUrl);
        });
      }
    } catch (fatalErr) {
      console.error('Playback failed:', fatalErr);
      fallbackBrowserTTS(replyText);
    }
  }

  let activeUtterance = null;
  function fallbackBrowserTTS(text) {
    if ('speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch (e) {}
      isAgentSpeaking = true;
      safeStopRecognition();
      orbIntensity = 0.95;
      elBtnMic.classList.add('speaking');
      elStatus.textContent = '🔊 AGENT SPEAKING';

      const u = new SpeechSynthesisUtterance(text);
      activeUtterance = u;
      u.lang = 'en-US';
      u.rate = 1.0;
      u.pitch = (currentVoice === 'azoth' || currentVoice === 'chronos') ? 0.9 : 1.05;

      try {
        const voices = window.speechSynthesis.getVoices();
        if (voices && voices.length > 0) {
          const bestVoice = voices.find(v => v.lang && v.lang.startsWith('en') && (v.name.includes('Natural') || v.name.includes('Google') || v.name.includes('Siri') || v.name.includes('Neural'))) ||
                            voices.find(v => v.lang && v.lang.startsWith('en'));
          if (bestVoice) u.voice = bestVoice;
        }
      } catch (e) {}

      u.onend = () => {
        isAgentSpeaking = false;
        activeUtterance = null;
        elBtnMic.classList.remove('speaking');
        elStatus.textContent = 'CALL ACTIVE • LISTENING';
        setTimeout(() => { resumeListening(); }, 250);
      };
      u.onerror = () => {
        isAgentSpeaking = false;
        activeUtterance = null;
        elBtnMic.classList.remove('speaking');
        elStatus.textContent = 'CALL ACTIVE • LISTENING';
        resumeListening();
      };
      window.speechSynthesis.speak(u);
    } else {
      isAgentSpeaking = false;
      resumeListening();
    }
  }

  function showUnmuteBanner(b64Data, mime, replyText, blobUrl) {
    pendingAudio = { b64Data, mime, replyText, blobUrl };
    elUnmuteBanner.style.display = 'flex';
    elStatus.textContent = 'AUDIO PAUSED • TAP TO UNMUTE';
  }

  function hideUnmuteBanner() {
    elUnmuteBanner.style.display = 'none';
    pendingAudio = null;
  }

  async function handleUnmuteGesture() {
    await unlockAudio();
    if (pendingAudio) {
      const { b64Data, mime, replyText } = pendingAudio;
      pendingAudio = null;
      hideUnmuteBanner();
      playAgentAudio(b64Data, mime, replyText);
    }
  }

  function resumeListening() {
    if (isListening && !isAgentSpeaking && !isProcessingUtterance) {
      clearTimeout(recognitionRestartTimer);
      recognitionRestartTimer = setTimeout(() => {
        safeStartRecognition();
      }, 250);
    }
  }

  // 9. Transcript & Turn Management
  function appendAgentBubble(text, b64Data, mime, latencyMs) {
    const turnId = `turn_${Date.now()}`;
    if (b64Data) {
      turnAudioMap.set(turnId, { b64Data, mime, text });
    }
    const latencyBadge = latencyMs !== undefined ? `<span style="font-size:0.72rem; color:#10B981; margin-left:8px;">⚡ ${latencyMs}ms · WAV</span>` : '';

    const bubble = document.createElement('div');
    bubble.className = 'turn-bubble agent-turn';
    bubble.innerHTML = `
      <div class="turn-header-row">
        <span class="turn-speaker">${currentVoice.toUpperCase()}${latencyBadge}</span>
        ${b64Data ? `<button class="turn-replay-btn" data-turn-id="${turnId}" title="Replay turn">🔊 Replay</button>` : ''}
      </div>
      <p class="turn-text">"${text}"</p>
    `;
    elTranscriptViewport.appendChild(bubble);
    elTranscriptViewport.scrollTop = elTranscriptViewport.scrollHeight;

    const btnReplay = bubble.querySelector('.turn-replay-btn');
    if (btnReplay) {
      btnReplay.addEventListener('click', (e) => {
        e.stopPropagation();
        unlockAudio();
        const t = turnAudioMap.get(turnId);
        if (t) {
          playAgentAudio(t.b64Data, t.mime, t.text);
        }
      });
    }
  }

  // 10. Interactive Controls
  elBtnUnmuteTap.addEventListener('click', handleUnmuteGesture);
  elUnmuteBanner.addEventListener('click', handleUnmuteGesture);

  window.addEventListener('pointerdown', () => {
    if (!audioUnlocked) {
      unlockAudio();
    }
  }, { once: false, passive: true });

  // Speaker Test Button
  elBtnTestSpeaker.addEventListener('click', async (e) => {
    e.stopPropagation();
    await unlockAudio();
    elStatus.textContent = 'TESTING AUDIO 🔊';

    try {
      const res = await fetch(`/api/call/welcome?voice=${encodeURIComponent(currentVoice)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.audio_base64) {
          await playAgentAudio(data.audio_base64, data.audio_mime || 'audio/wav', data.text);
          return;
        }
      }
    } catch (err) {}

    fallbackBrowserTTS(`Audio bridge operational on ${currentVoice}. Loud and clear.`);
  });

  // Voice Persona Selector Cycle
  elBtnVoice.addEventListener('click', () => {
    const idx = voicesList.indexOf(currentVoice);
    currentVoice = voicesList[(idx + 1) % voicesList.length];
    const vLabel = currentVoice.charAt(0).toUpperCase() + currentVoice.slice(1);
    elLblVoice.textContent = `Voice: ${vLabel}`;
    elPersonaName.textContent = currentVoice.toUpperCase();
    elPersonaRole.textContent = voiceRoles[currentVoice] || 'Sovereign AI';
    elLiveAgentText.textContent = `"Switched voice persona to ${vLabel}. Ready."`;
  });

  // Mic Button: Tap to Send (Push-to-Talk) or Toggle Mute
  elBtnMic.addEventListener('click', async () => {
    await unlockAudio();

    // If user has text in input or spoken text, tapping mic immediately sends!
    const pendingText = (elInputFallBackText ? elInputFallBackText.value : activeUserSpeech).trim();
    if (pendingText.length > 0) {
      finalizeAndSendUtterance();
      return;
    }

    if (isListening) {
      isListening = false;
      safeStopRecognition();
      elBtnMic.classList.remove('active');
      elBtnMic.classList.add('muted');
      elStatus.textContent = 'MIC MUTED';
    } else {
      isListening = true;
      elBtnMic.classList.add('active');
      elBtnMic.classList.remove('muted');
      elStatus.textContent = 'CALL ACTIVE • LISTENING';
      safeStartRecognition();
    }
  });

  // Text Input Send: Handles ENTER key to send when done
  function handleSendText() {
    clearTimeout(speechSilenceTimer);
    clearInterval(countdownTimer);
    const text = elInputFallBackText.value.trim() || activeUserSpeech.trim();
    if (!text || isProcessingUtterance) return;

    if (isAgentSpeaking) {
      if (currentSourceNode) {
        try { currentSourceNode.onended = null; currentSourceNode.stop(); } catch (e) {}
        currentSourceNode = null;
      }
      if (fallbackAudioPlayer) fallbackAudioPlayer.pause();
      isAgentSpeaking = false;
    }

    elInputFallBackText.value = '';
    activeUserSpeech = '';
    elUserLiveBubble.style.display = 'block';
    elLiveUserText.textContent = text;
    sendUtteranceToAgent(text);
  }

  elBtnSendFallBack.addEventListener('click', handleSendText);
  elInputFallBackText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSendText();
    }
  });

  // Replay Initial Welcome Turn
  if (elBtnReplayInitial) {
    elBtnReplayInitial.addEventListener('click', async (e) => {
      e.stopPropagation();
      await unlockAudio();
      try {
        const res = await fetch(`/api/call/welcome?voice=${encodeURIComponent(currentVoice)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.audio_base64) {
            playAgentAudio(data.audio_base64, data.audio_mime || 'audio/wav', data.text);
            return;
          }
        }
      } catch (err) {}
      fallbackBrowserTTS("I am on the line, Neal. Tap the mic or speak naturally—I am listening.");
    });
  }

  // End Call Button
  elBtnEndCall.addEventListener('click', async () => {
    clearInterval(timerInterval);
    clearInterval(countdownTimer);
    clearTimeout(speechSilenceTimer);
    safeStopRecognition();
    if (currentSourceNode) try { currentSourceNode.stop(); } catch (e) {}
    if (fallbackAudioPlayer) fallbackAudioPlayer.pause();

    elStatus.textContent = 'CALL DISCONNECTED';
    const durationStr = elTimer.textContent;

    try {
      const res = await fetch('/api/call/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token })
      });
      const endData = await res.json();
      const s = endData.summary || {};
      elModalDuration.textContent = `Session: ${s.session_id || 'active'} • Duration: ${durationStr} • Turns: ${s.total_turns || 2} • Voice: ${(s.voice || currentVoice).toUpperCase()}`;
      elModalDebrief.textContent = s.dialogue
        ? `${s.dialogue}\n\n✓ Synced to Neuro-Memory (:8094), Flight Recorder (:8104) & Signal/SimpleX.`
        : `Transcript and key decisions have been delivered to your Signal (+19482047987) and SimpleX (@1nc0gn30) channels.`;
      elModalDebrief.style.whiteSpace = 'pre-wrap';
      elModalDebrief.style.textAlign = 'left';
      elModal.style.display = 'flex';
    } catch (err) {
      elModalDuration.textContent = `Duration: ${durationStr}`;
      elModal.style.display = 'flex';
    }
  });

  // Join Call Overlay Action (Direct User Gesture unlocks audio context & mic)
  elBtnJoinCall.addEventListener('click', async () => {
    await unlockAudio();
    elJoinOverlay.style.display = 'none';
    startCallTimer();
    setupSpeechRecognition();

    // Fetch welcome voice note and play aloud
    try {
      elStatus.textContent = 'CONNECTING...';
      const res = await fetch(`/api/call/welcome?voice=${encodeURIComponent(currentVoice)}`);
      if (res.ok) {
        const data = await res.json();
        elLiveAgentText.textContent = `"${data.text}"`;
        appendAgentBubble(data.text, data.audio_base64, data.audio_mime || 'audio/wav');
        if (data.audio_base64) {
          await playAgentAudio(data.audio_base64, data.audio_mime || 'audio/wav', data.text);
        } else {
          fallbackBrowserTTS(data.text);
        }
      }
    } catch (e) {
      console.warn('Welcome voice fetch error:', e);
      fallbackBrowserTTS(`Live on the line, Neal. Azoth is listening.`);
    }
  });

  // 11. Initialization
  async function initSession() {
    elChannel.textContent = `${channel.toUpperCase()} BRIDGE`;

    try {
      const res = await fetch(`/api/call/session?token=${encodeURIComponent(token)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.token) token = data.token;
        currentVoice = data.voice || 'azoth';
        elPersonaName.textContent = currentVoice.toUpperCase();
        elPersonaRole.textContent = voiceRoles[currentVoice] || 'Sovereign AI';
        elLblVoice.textContent = `Voice: ${currentVoice.charAt(0).toUpperCase() + currentVoice.slice(1)}`;
        if (elJoinVoiceName) elJoinVoiceName.textContent = currentVoice.toUpperCase();
      }
    } catch (e) {
      console.warn('Session init warning:', e);
    }

    startCallTimer();
    renderOrb();
  }

  initSession();
})();
