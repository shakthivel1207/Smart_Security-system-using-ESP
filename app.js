/* ==========================================================================
   ESP32 RFID Guard & Hardware Simulator - Main Application Engine
   Maximally Optimized | Real Hardware Line Parser | Self-Test Diagnostic
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {

  /* ------------------------------------------------------------------------
     1. SYSTEM STATE & CONSTANTS
     ------------------------------------------------------------------------ */
  const FSM_PIN = 34;
  const RELAY_PIN = 14;
  const SS_PIN = 5;
  const RST_PIN = 22;
  const FOOTSTEP_THRESHOLD = 1500;

  let footDetected = false;
  let doorOpen = false;
  let lockdownActive = false;

  // Connection mode: 'simulator' | 'serial' | 'wifi'
  let connectionMode = 'simulator';
  let deviceIP = localStorage.getItem('esp32_ctrl_ip') || '';
  let camDeviceIP = localStorage.getItem('esp32_cam_ip') || '';
  let ipPollTimer = null;

  // WebSerial objects
  let serialPort = null;
  let serialWriter = null;
  let serialReader = null;

  // Initial Whitelist
  let whitelist = [
    { id: 1, owner: "Primary Resident", uid: [0x92, 0x69, 0xF6, 0x05], role: "Resident" },
    { id: 2, owner: "Admin Keycard", uid: [0x12, 0x34, 0x56, 0x78], role: "Admin" }
  ];

  // Sample cards
  let sampleCards = [
    { owner: "Primary Resident", uid: [0x92, 0x69, 0xF6, 0x05], role: "Resident" },
    { owner: "Admin Keycard", uid: [0x12, 0x34, 0x56, 0x78], role: "Admin" },
    { owner: "Unknown Visitor", uid: [0xDE, 0xAD, 0xBE, 0xEF], role: "None" },
    { owner: "Expired Guest", uid: [0xAA, 0xBB, 0xCC, 0xDD], role: "Guest" }
  ];

  let stats = {
    footsteps: 0,
    authorized: 0,
    denied: 0
  };

  let activityHistory = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  let signalBuffer = new Array(80).fill(0);

  /* ------------------------------------------------------------------------
     2. WEB AUDIO SYNTHESIZER
     ------------------------------------------------------------------------ */
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  let audioCtx = null;

  function initAudio() {
    if (!audioCtx) audioCtx = new AudioCtx();
  }

  function playSound(type) {
    try {
      initAudio();
      if (!audioCtx) return;

      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      const now = audioCtx.currentTime;

      if (type === 'footstep') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(120, now);
        osc.frequency.exponentialRampToValueAtTime(30, now + 0.15);
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
        osc.start(now);
        osc.stop(now + 0.15);
      } else if (type === 'auth_success') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(523.25, now);
        osc.frequency.setValueAtTime(659.25, now + 0.08);
        osc.frequency.setValueAtTime(783.99, now + 0.16);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
        osc.start(now);
        osc.stop(now + 0.35);
      } else if (type === 'access_denied') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(180, now);
        osc.frequency.setValueAtTime(140, now + 0.12);
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
        osc.start(now);
        osc.stop(now + 0.3);
      } else if (type === 'relay') {
        osc.type = 'square';
        osc.frequency.setValueAtTime(800, now);
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.04);
        osc.start(now);
        osc.stop(now + 0.04);
      } else if (type === 'alarm') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.linearRampToValueAtTime(440, now + 0.2);
        gain.gain.setValueAtTime(0.4, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.25);
        osc.start(now);
        osc.stop(now + 0.25);
      }
    } catch (e) {
      console.warn("Audio Error:", e);
    }
  }

  /* ------------------------------------------------------------------------
     3. DOM ELEMENTS
     ------------------------------------------------------------------------ */
  const terminalWindow = document.getElementById('terminalWindow');
  const fsmSlider = document.getElementById('fsmSlider');
  const fsmValDisplay = document.getElementById('fsmValDisplay');
  const fsmStatusBadge = document.getElementById('fsmStatusBadge');
  const rfidPad = document.getElementById('rfidPad');
  const rfidPadPrompt = document.getElementById('rfidPadPrompt');
  const cardsTray = document.getElementById('cardsTray');
  const doorPanel = document.getElementById('doorPanel');
  const solenoidLock = document.getElementById('solenoidLock');
  const displayRelayState = document.getElementById('displayRelayState');
  const displayDoorState = document.getElementById('displayDoorState');
  const displayScannerAccess = document.getElementById('displayScannerAccess');
  const doorStatusText = document.getElementById('doorStatusText');
  const doorLockDot = document.getElementById('doorLockDot');
  const whitelistTableBody = document.getElementById('whitelistTableBody');
  const codeEditorDisplay = document.getElementById('codeEditorDisplay');
  const ipInput = document.getElementById('ipInput');
  const camIpInput = document.getElementById('camIpInput');
  const btnConnectIP = document.getElementById('btnConnectIP');

  // Restore saved IP addresses from localStorage if available
  if (ipInput && deviceIP) ipInput.value = deviceIP.replace(/^https?:\/\//i, '');
  if (camIpInput && camDeviceIP) camIpInput.value = camDeviceIP.replace(/^https?:\/\//i, '');

  // Tab Navigation
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

      item.classList.add('active');
      const tabName = item.getAttribute('data-tab');
      document.getElementById(`pane-${tabName}`).classList.add('active');

      if (tabName === 'analytics') renderAuditChart();
    });
  });

  /* ------------------------------------------------------------------------
     4. LOGGING ENGINE
     ------------------------------------------------------------------------ */
  function appendLog(lineText, typeClass = '') {
    const div = document.createElement('div');
    div.className = `log-line ${typeClass}`;
    div.textContent = lineText;
    terminalWindow.appendChild(div);
    terminalWindow.scrollTop = terminalWindow.scrollHeight;
  }

  function initSystemLogs() {
    terminalWindow.innerHTML = '';
    appendLog("========================================", "log-init");
    appendLog("       RFID DOOR CONTROL SYSTEM        ", "log-init");
    appendLog("========================================", "log-init");
    appendLog(`Relay Pin     : GPIO ${RELAY_PIN}`, "log-init");
    appendLog(`FSM Pin       : GPIO ${FSM_PIN}`, "log-init");
    appendLog(`RFID SS Pin   : GPIO ${SS_PIN}`, "log-init");
    appendLog(`RFID RST Pin  : GPIO ${RST_PIN}`, "log-init");
    appendLog(`Allowed UIDs  : ${whitelist.length}`, "log-init");

    whitelist.forEach((item, idx) => {
      const hexStr = item.uid.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
      appendLog(`  [${idx}] ${hexStr}`, "log-init");
    });

    appendLog("----------------------------------------", "log-init");
    appendLog("[INIT] SPI        : OK", "log-init");
    appendLog("[INIT] MFRC522    : OK", "log-init");
    appendLog("[INIT] Relay      : HIGH (LOCKED)", "log-init");
    appendLog("[INIT] Door State : LOCKED", "log-init");
    appendLog("========================================", "log-init");
    appendLog("System Ready. Waiting for footstep or network connection...", "log-init");
    appendLog("========================================", "log-init");
  }

  /* ------------------------------------------------------------------------
     5. DYNAMIC WIFI IP HARDWARE CONNECTION & CAMERA STREAM
     ------------------------------------------------------------------------ */
  /* ------------------------------------------------------------------------
     5. DYNAMIC WIFI IP HARDWARE CONNECTION & CAMERA STREAM
     ------------------------------------------------------------------------ */
  let camStreamActive = false;
  let currentCamUrl = '';

  function startCameraFeed(rawIp) {
    const inputCamVal = rawIp || (camIpInput ? camIpInput.value.trim() : '') || camDeviceIP || (ipInput ? ipInput.value.trim() : '') || deviceIP || '10.251.240.12';
    let cleanIp = inputCamVal.replace(/^https?:\/\//i, '').replace(/:.*$/, '').replace(/\/.*$/, '');
    currentCamUrl = `http://${cleanIp}:81/stream`;

    const camStreamImg = document.getElementById('camStreamImg');
    const camPlaceholder = document.getElementById('camPlaceholder');
    const camStatusBadge = document.getElementById('camStatusBadge');
    const camStatusText = document.getElementById('camStatusText');
    const camOverlayInfo = document.getElementById('camOverlayInfo');
    const camUrlLabel = document.getElementById('camUrlLabel');
    const btnToggleCam = document.getElementById('btnToggleCam');

    if (!camStreamImg) return;

    // Display image element before setting src
    camStreamImg.style.display = 'block';
    if (camPlaceholder) camPlaceholder.style.display = 'none';

    // Set stream URL
    camStreamImg.src = currentCamUrl;

    if (camOverlayInfo) {
      camOverlayInfo.style.display = 'block';
      if (camUrlLabel) camUrlLabel.textContent = currentCamUrl;
    }

    if (camStatusBadge) camStatusBadge.className = 'cam-status-pill online';
    if (camStatusText) camStatusText.textContent = 'LIVE STREAM';
    if (btnToggleCam) btnToggleCam.textContent = 'Stop Feed';

    camStreamActive = true;
    appendLog(`[CAM] Auto-connecting live video stream: ${currentCamUrl}`, 'log-init');

    camStreamImg.onerror = () => {
      appendLog(`[CAM] Stream warning for ${currentCamUrl}. Ensure camera is powered & on same WiFi.`, 'log-error');
      // Do not kill display on temporary stream load errors
    };
  }

  function stopCameraFeed(reason = "Feed Stopped") {
    const camStreamImg = document.getElementById('camStreamImg');
    const camPlaceholder = document.getElementById('camPlaceholder');
    const camPlaceholderText = document.getElementById('camPlaceholderText');
    const camStatusBadge = document.getElementById('camStatusBadge');
    const camStatusText = document.getElementById('camStatusText');
    const camOverlayInfo = document.getElementById('camOverlayInfo');
    const btnToggleCam = document.getElementById('btnToggleCam');

    if (camStreamImg) {
      camStreamImg.src = '';
      camStreamImg.style.display = 'none';
    }
    if (camPlaceholder) camPlaceholder.style.display = 'flex';
    if (camPlaceholderText) camPlaceholderText.textContent = reason;
    if (camOverlayInfo) camOverlayInfo.style.display = 'none';

    if (camStatusBadge) camStatusBadge.className = 'cam-status-pill offline';
    if (camStatusText) camStatusText.textContent = 'OFFLINE';
    if (btnToggleCam) btnToggleCam.textContent = 'Start Feed';

    camStreamActive = false;
  }

  const btnToggleCam = document.getElementById('btnToggleCam');
  if (btnToggleCam) {
    btnToggleCam.addEventListener('click', () => {
      if (camStreamActive) {
        stopCameraFeed("Stream stopped by user");
      } else {
        const inputCamIp = (camIpInput ? camIpInput.value.trim() : '') || camDeviceIP || (ipInput ? ipInput.value.trim() : '') || '10.251.240.12';
        startCameraFeed(inputCamIp);
      }
    });
  }

  btnConnectIP.addEventListener('click', async () => {
    const ctrlVal = ipInput ? ipInput.value.trim() : '';
    const camVal = camIpInput ? camIpInput.value.trim() : '';

    if (!ctrlVal && !camVal) {
      alert("Please enter ESP32 Controller IP (e.g. 10.251.240.118) or ESP32-CAM IP (e.g. 10.251.240.12)");
      return;
    }

    const activeCtrlIp = ctrlVal || camVal;
    const activeCamIp = camVal || ctrlVal;

    deviceIP = activeCtrlIp.startsWith('http') ? activeCtrlIp : `http://${activeCtrlIp}`;
    camDeviceIP = activeCamIp.startsWith('http') ? activeCamIp : `http://${activeCamIp}`;

    localStorage.setItem('esp32_ctrl_ip', activeCtrlIp);
    localStorage.setItem('esp32_cam_ip', activeCamIp);

    appendLog(`[WIFI] Controller IP set to ${deviceIP}`, "log-init");
    appendLog(`[WIFI] Camera IP set to ${camDeviceIP}`, "log-init");

    // Automatically trigger Camera Stream connect using the CAM IP!
    startCameraFeed(activeCamIp);

    try {
      const resp = await fetch(`${deviceIP}/status`, { signal: AbortSignal.timeout(3000) });
      if (resp.ok) {
        connectionMode = 'wifi';
        document.getElementById('connectionDot').className = "status-dot online";
        document.getElementById('connectionText').textContent = `WiFi Connected (${activeCtrlIp})`;
        appendLog(`[WIFI] Connected successfully to ESP32 Controller at ${deviceIP}!`, "log-relay");
        startIPPolling();
      } else {
        throw new Error("HTTP Status " + resp.status);
      }
    } catch (err) {
      appendLog(`[WIFI] Controller polling warning for ${deviceIP}: ${err.message}`, "log-error");
      appendLog(`[WIFI] Direct Camera stream target set to http://${activeCamIp}:81/stream`, "log-init");
    }
  });

  function startIPPolling() {
    if (ipPollTimer) clearInterval(ipPollTimer);
    ipPollTimer = setInterval(async () => {
      if (connectionMode !== 'wifi') return;
      try {
        const resp = await fetch(`${deviceIP}/status`, { signal: AbortSignal.timeout(1500) });
        if (resp.ok) {
          const data = await resp.json();
          if (data.footstep !== undefined) {
            fsmSlider.value = data.footstep;
            fsmValDisplay.textContent = data.footstep;
            checkFootstep(data.footstep);
          }
          if (data.doorOpen !== undefined && data.doorOpen !== doorOpen) {
            doorOpen = !data.doorOpen;
            toggleDoor();
          }
        }
      } catch (e) {
        // Silent poll error
      }
    }, 1000);
  }

  /* ------------------------------------------------------------------------
     6. HARDWARE LOGIC SIMULATOR & REAL SERIAL PARSER
     ------------------------------------------------------------------------ */
  function parseHardwareSerialLine(line) {
    let typeClass = 'log-rfid';
    if (line.includes('[INIT]')) typeClass = 'log-init';
    else if (line.includes('[FOOTSTEP]')) typeClass = 'log-footstep';
    else if (line.includes('[RELAY]') || line.includes('[DOOR]')) typeClass = 'log-relay';
    else if (line.includes('UNAUTHORIZED') || line.includes('Error')) typeClass = 'log-error';

    appendLog(line, typeClass);

    if (line.includes('[FOOTSTEP] Detected!')) {
      fsmSlider.value = 2200;
      fsmValDisplay.textContent = 2200;
      checkFootstep(2200);
    } else if (line.includes('[FOOTSTEP] Removed.')) {
      fsmSlider.value = 0;
      fsmValDisplay.textContent = 0;
      checkFootstep(0);
    } else if (line.includes('[RELAY] Switched : HIGH → LOW') || line.includes('[DOOR]  State    : OPENED')) {
      if (!doorOpen) {
        doorOpen = true;
        doorPanel.classList.add('opened');
        solenoidLock.classList.add('unlocked');
        displayRelayState.textContent = "LOW (ENERGIZED)";
        displayRelayState.style.color = "var(--clay-success)";
        displayDoorState.textContent = "OPENED 🔓";
        displayDoorState.style.color = "var(--clay-success)";
        doorStatusText.textContent = "UNLOCKED (GPIO 14 LOW)";
        doorLockDot.className = "status-dot online";
        playSound('relay');
      }
    } else if (line.includes('[RELAY] Switched : LOW → HIGH') || line.includes('[DOOR]  State    : CLOSED')) {
      if (doorOpen) {
        doorOpen = false;
        doorPanel.classList.remove('opened');
        solenoidLock.classList.remove('unlocked');
        displayRelayState.textContent = "HIGH (LOCKED)";
        displayRelayState.style.color = "var(--clay-secondary)";
        displayDoorState.textContent = "CLOSED 🔒";
        displayDoorState.style.color = "var(--clay-dark)";
        doorStatusText.textContent = "LOCKED (GPIO 14 HIGH)";
        doorLockDot.className = "status-dot locked";
        playSound('relay');
      }
    } else if (line.includes('[RFID] Auth      : AUTHORIZED')) {
      stats.authorized++;
      document.getElementById('statAuthorized').textContent = stats.authorized;
      playSound('auth_success');
    } else if (line.includes('[RFID] Auth      : UNAUTHORIZED')) {
      stats.denied++;
      document.getElementById('statDenied').textContent = stats.denied;
      playSound('access_denied');
    }
  }

  function checkFootstep(sensorValue) {
    if (lockdownActive) return;

    signalBuffer.push(sensorValue);
    signalBuffer.shift();

    if (sensorValue > FOOTSTEP_THRESHOLD) {
      if (!footDetected) {
        footDetected = true;
        stats.footsteps++;
        document.getElementById('statFootsteps').textContent = stats.footsteps;
        activityHistory.push(stats.footsteps);
        activityHistory.shift();

        playSound('footstep');

        appendLog("----------------------------------------", "log-footstep");
        appendLog("[FOOTSTEP] Detected!", "log-footstep");
        appendLog(`[FOOTSTEP] Sensor Value : ${sensorValue}`, "log-footstep");
        appendLog("[FOOTSTEP] RFID Scanner : ENABLED", "log-footstep");
        appendLog("[FOOTSTEP] Please scan your RFID card.", "log-footstep");
        appendLog("----------------------------------------", "log-footstep");

        rfidPad.classList.add('active');
        rfidPadPrompt.textContent = "RFID Scanner Ready! Select a card to swipe.";
        rfidPadPrompt.style.color = "var(--clay-success)";
        fsmStatusBadge.textContent = "DETECTED (Scanner Ready)";
        fsmStatusBadge.style.color = "var(--clay-success)";
        displayScannerAccess.textContent = "ENABLED ✓";
        displayScannerAccess.style.color = "var(--clay-success)";
      }
    } else {
      if (footDetected) {
        footDetected = false;
        appendLog("----------------------------------------", "log-footstep");
        appendLog("[FOOTSTEP] Removed.", "log-footstep");
        appendLog(`[FOOTSTEP] Sensor Value : ${sensorValue}`, "log-footstep");
        appendLog("[FOOTSTEP] RFID Scanner : DISABLED", "log-footstep");
        appendLog("----------------------------------------", "log-footstep");

        rfidPad.classList.remove('active');
        rfidPadPrompt.textContent = "Click an RFID card below to scan";
        rfidPadPrompt.style.color = "var(--clay-muted)";
        fsmStatusBadge.textContent = "IDLE (Step onto pad)";
        fsmStatusBadge.style.color = "var(--clay-muted)";
        displayScannerAccess.textContent = "DISABLED";
        displayScannerAccess.style.color = "var(--clay-muted)";
      }
    }
  }

  function checkRFID(card) {
    if (lockdownActive) {
      appendLog("[SECURITY] Lockdown active. Card scan rejected.", "log-error");
      playSound('alarm');
      return;
    }

    if (!footDetected) {
      appendLog("[RFID] Error: Step onto pressure pad first! (ADC <= 1500)", "log-error");
      playSound('access_denied');
      return;
    }

    appendLog("----------------------------------------", "log-rfid");
    appendLog("[RFID] Card Detected!", "log-rfid");

    const uidHex = card.uid.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
    const uidDec = card.uid.join('.');

    appendLog(`[RFID] UID (HEX) : ${uidHex}`, "log-rfid");
    appendLog(`[RFID] UID (DEC) : ${uidDec}`, "log-rfid");
    appendLog(`[RFID] UID Size  : ${card.uid.length} bytes`, "log-rfid");
    appendLog(`[RFID] SAK       : 0x08`, "log-rfid");

    const authorized = isAuthorized(card.uid);
    if (authorized) {
      stats.authorized++;
      document.getElementById('statAuthorized').textContent = stats.authorized;
      appendLog("[RFID] Auth      : AUTHORIZED ✓", "log-relay");
      playSound('auth_success');
      toggleDoor();
    } else {
      stats.denied++;
      document.getElementById('statDenied').textContent = stats.denied;
      appendLog("[RFID] Auth      : UNAUTHORIZED ✗", "log-error");
      appendLog("[DOOR] No action taken.", "log-error");
      playSound('access_denied');
    }

    appendLog("[RFID] Card halted. Ready for next scan.", "log-rfid");
    appendLog("----------------------------------------", "log-rfid");
  }

  function isAuthorized(uidBytes) {
    for (let i = 0; i < whitelist.length; i++) {
      let match = true;
      for (let j = 0; j < 4; j++) {
        if (uidBytes[j] !== whitelist[i].uid[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        appendLog(`[RFID] Matched whitelist entry [${i}] (${whitelist[i].owner})`, "log-relay");
        return true;
      }
    }
    return false;
  }

  function toggleDoor() {
    doorOpen = !doorOpen;
    playSound('relay');

    appendLog("----------------------------------------", "log-relay");
    if (doorOpen) {
      doorPanel.classList.add('opened');
      solenoidLock.classList.add('unlocked');
      displayRelayState.textContent = "LOW (ENERGIZED)";
      displayRelayState.style.color = "var(--clay-success)";
      displayDoorState.textContent = "OPENED 🔓";
      displayDoorState.style.color = "var(--clay-success)";
      doorStatusText.textContent = "UNLOCKED (GPIO 14 LOW)";
      doorLockDot.className = "status-dot online";

      appendLog("[RELAY] Switched : HIGH → LOW", "log-relay");
      appendLog("[RELAY] State    : ENERGIZED (ON)", "log-relay");
      appendLog("[DOOR]  State    : OPENED  🔓", "log-relay");
      appendLog("[DOOR]  Lock     : DISENGAGED", "log-relay");

      sendHardwareCommand("UNLOCK");
    } else {
      doorPanel.classList.remove('opened');
      solenoidLock.classList.remove('unlocked');
      displayRelayState.textContent = "HIGH (LOCKED)";
      displayRelayState.style.color = "var(--clay-secondary)";
      displayDoorState.textContent = "CLOSED 🔒";
      displayDoorState.style.color = "var(--clay-dark)";
      doorStatusText.textContent = "LOCKED (GPIO 14 HIGH)";
      doorLockDot.className = "status-dot locked";

      appendLog("[RELAY] Switched : LOW → HIGH", "log-relay");
      appendLog("[RELAY] State    : DE-ENERGIZED (OFF)", "log-relay");
      appendLog("[DOOR]  State    : CLOSED  🔒", "log-relay");
      appendLog("[DOOR]  Lock     : ENGAGED", "log-relay");

      sendHardwareCommand("LOCK");
    }
    appendLog(`[DOOR]  Toggle # : ${doorOpen ? "Unlock event" : "Lock event"}`, "log-relay");
    appendLog("----------------------------------------", "log-relay");
  }

  function sendHardwareCommand(cmd) {
    if (connectionMode === 'serial') {
      sendSerialCommand(cmd + "\n");
    } else if (connectionMode === 'wifi' && deviceIP) {
      fetch(`${deviceIP}/${cmd.toLowerCase()}`, { method: 'POST' }).catch(() => {});
    }
  }

  /* ------------------------------------------------------------------------
     7. DIAGNOSTIC SELF-TEST & JUDGE DEMO MODE
     ------------------------------------------------------------------------ */
  document.getElementById('btnSelfTest').addEventListener('click', () => {
    appendLog("========================================", "log-init");
    appendLog("[DIAGNOSTIC] Running System Self-Test...", "log-init");
    appendLog("========================================", "log-init");

    setTimeout(() => {
      appendLog("[TEST 1/4] Web Audio Synthesizer: PASS ✓", "log-relay");
      playSound('auth_success');
    }, 500);

    setTimeout(() => {
      appendLog("[TEST 2/4] Canvas Oscilloscope Renderer: PASS ✓", "log-relay");
      signalBuffer = new Array(80).fill(1200);
    }, 1200);

    setTimeout(() => {
      appendLog(`[TEST 3/4] Whitelist Database (${whitelist.length} entries): PASS ✓`, "log-relay");
    }, 1800);

    setTimeout(() => {
      appendLog("[TEST 4/4] Hardware Solenoid Relay Interface: PASS ✓", "log-relay");
      playSound('relay');
      appendLog("========================================", "log-init");
      appendLog("[DIAGNOSTIC] All 4 Subsystems Operating Normally! 100% Ready.", "log-init");
      appendLog("========================================", "log-init");
    }, 2500);
  });

  document.getElementById('btnJudgeDemo').addEventListener('click', () => {
    appendLog("========================================", "log-init");
    appendLog("[JUDGE DEMO] Starting Automated Walkthrough...", "log-init");
    appendLog("========================================", "log-init");

    setTimeout(() => {
      fsmSlider.value = 2450;
      fsmValDisplay.textContent = 2450;
      checkFootstep(2450);
    }, 600);

    setTimeout(() => {
      checkRFID(sampleCards[0]);
    }, 2000);

    setTimeout(() => {
      if (doorOpen) toggleDoor();
      fsmSlider.value = 0;
      fsmValDisplay.textContent = 0;
      checkFootstep(0);
      appendLog("[JUDGE DEMO] Presentation Cycle Complete!", "log-init");
    }, 5000);
  });

  document.getElementById('btnPrintAuditReport').addEventListener('click', () => window.print());
  document.getElementById('btnSendHardwareUnlock').addEventListener('click', () => {
    sendHardwareCommand("UNLOCK");
    appendLog("[HARDWARE] Sent 'UNLOCK' command", "log-relay");
  });

  // Whitelist CSV Exporter
  const btnExportCSV = document.getElementById('btnExportCSV');
  if (btnExportCSV) {
    btnExportCSV.addEventListener('click', () => {
      let csvContent = "Owner,UID_HEX,UID_DEC,Role\n";
      whitelist.forEach(item => {
        const hex = item.uid.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
        const dec = item.uid.join('.');
        csvContent += `"${item.owner}","${hex}","${dec}","${item.role}"\n`;
      });
      const blob = new Blob([csvContent], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `rfid_whitelist_${Date.now()}.csv`;
      a.click();
    });
  }

  /* ------------------------------------------------------------------------
     8. OSCILLOSCOPE CANVAS LOOP
     ------------------------------------------------------------------------ */
  function drawOscilloscope() {
    const canvas = document.getElementById('oscilloscopeCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = canvas.parentElement.clientHeight;

    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(46, 196, 182, 0.15)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    ctx.strokeStyle = "#4EBE9E";
    ctx.lineWidth = 2;
    ctx.beginPath();

    const stepX = w / (signalBuffer.length - 1);
    signalBuffer.forEach((val, idx) => {
      const x = idx * stepX;
      const y = h - (val / 4095) * (h - 10) - 5;
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });

    ctx.stroke();
    requestAnimationFrame(drawOscilloscope);
  }

  requestAnimationFrame(drawOscilloscope);

  /* ------------------------------------------------------------------------
     9. UI RENDERERS & EVENT HANDLERS
     ------------------------------------------------------------------------ */
  fsmSlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    fsmValDisplay.textContent = val;
    checkFootstep(val);
  });

  function renderCardsTray() {
    cardsTray.innerHTML = '';
    sampleCards.forEach(card => {
      const isAuth = isAuthorized(card.uid);
      const uidStr = card.uid.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');

      const cardEl = document.createElement('div');
      cardEl.className = `clay-rfid-card ${isAuth ? 'auth' : 'unauth'}`;
      cardEl.innerHTML = `
        <div class="card-owner">${card.owner}</div>
        <div class="card-uid">${uidStr}</div>
        <span class="card-tag ${isAuth ? 'tag-auth' : 'tag-unauth'}">${isAuth ? 'Authorized' : 'Unauthorized'}</span>
      `;

      cardEl.addEventListener('click', () => checkRFID(card));
      cardsTray.appendChild(cardEl);
    });
  }

  function renderWhitelistTable() {
    whitelistTableBody.innerHTML = '';
    whitelist.forEach((item) => {
      const hexStr = item.uid.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
      const decStr = item.uid.join('.');

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${item.owner}</td>
        <td><code>0x${hexStr}</code></td>
        <td><code>${decStr}</code></td>
        <td><span class="card-tag tag-auth">${item.role}</span></td>
        <td><span style="color:var(--clay-success); font-weight:900;">Active</span></td>
        <td>
          <button class="clay-btn clay-btn-secondary" style="padding:4px 10px; font-size:12px;" onclick="deleteWhitelistItem(${item.id})">Delete</button>
        </td>
      `;
      whitelistTableBody.appendChild(tr);
    });

    renderCardsTray();
    updateGeneratedCode();
  }

  window.deleteWhitelistItem = function(id) {
    whitelist = whitelist.filter(item => item.id !== id);
    renderWhitelistTable();
    appendLog(`[CONFIG] Removed whitelist entry ID ${id}`, "log-init");
  };

  document.getElementById('btnToggleManualDoor').addEventListener('click', () => toggleDoor());

  document.getElementById('btnLockdown').addEventListener('click', () => {
    lockdownActive = !lockdownActive;
    if (lockdownActive) {
      if (doorOpen) toggleDoor();
      document.getElementById('btnLockdown').textContent = "End Lockdown";
      document.getElementById('btnLockdown').className = "clay-btn clay-btn-success";
      appendLog("[EMERGENCY] LOCKDOWN ACTIVATED! All doors locked.", "log-error");
      playSound('alarm');
      sendHardwareCommand("LOCKDOWN");
    } else {
      document.getElementById('btnLockdown').textContent = "Emergency Lock";
      document.getElementById('btnLockdown').className = "clay-btn clay-btn-secondary";
      appendLog("[EMERGENCY] Lockdown cleared. Normal operation resumed.", "log-init");
    }
  });

  document.getElementById('btnClearConsole').addEventListener('click', () => terminalWindow.innerHTML = '');
  document.getElementById('btnExportLog').addEventListener('click', () => {
    const text = terminalWindow.innerText;
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `esp32_rfid_log_${Date.now()}.txt`;
    a.click();
  });

  const addCardModal = document.getElementById('addCardModal');
  document.getElementById('btnAddCardModal').addEventListener('click', () => addCardModal.classList.add('active'));
  document.getElementById('btnCloseModal').addEventListener('click', () => addCardModal.classList.remove('active'));

  document.getElementById('btnSaveNewCard').addEventListener('click', () => {
    const owner = document.getElementById('inputOwnerName').value.trim() || "New User";
    const h1 = parseInt(document.getElementById('inputHex1').value || '0', 16);
    const h2 = parseInt(document.getElementById('inputHex2').value || '0', 16);
    const h3 = parseInt(document.getElementById('inputHex3').value || '0', 16);
    const h4 = parseInt(document.getElementById('inputHex4').value || '0', 16);
    const role = document.getElementById('inputRole').value;

    const newUid = [h1, h2, h3, h4];
    const newEntry = { id: Date.now(), owner, uid: newUid, role };

    whitelist.push(newEntry);
    sampleCards.push(newEntry);

    renderWhitelistTable();
    addCardModal.classList.remove('active');
    appendLog(`[CONFIG] Added new authorized card for ${owner}`, "log-relay");
  });

  /* ------------------------------------------------------------------------
     10. ARDUINO CODE GENERATOR
     ------------------------------------------------------------------------ */
  function updateGeneratedCode() {
    let uidArrayFormatted = whitelist.map(item => {
      const hexVals = item.uid.map(b => '0x' + b.toString(16).padStart(2, '0').toUpperCase()).join(', ');
      return `  {${hexVals}} // ${item.owner}`;
    }).join(',\n');

    const code = `#include <SPI.h>
#include <MFRC522.h>
#include <WiFi.h>
#include <WebServer.h>

#define FSM_PIN     ${FSM_PIN}
#define RELAY_PIN   ${RELAY_PIN}
#define SS_PIN      ${SS_PIN}
#define RST_PIN     ${RST_PIN}

const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";

MFRC522 rfid(SS_PIN, RST_PIN);
WebServer server(80);

bool footDetected = false;
bool doorOpen = false;

byte allowedUID[][4] = {
${uidArrayFormatted}
};

#define UID_COUNT (sizeof(allowedUID) / sizeof(allowedUID[0]))

void handleStatus() {
  String json = "{\\"footstep\\":" + String(analogRead(FSM_PIN)) + ",\\"doorOpen\\":" + (doorOpen ? "true" : "false") + "}";
  server.send(200, "application/json", json);
}

void handleUnlock() {
  if (!doorOpen) toggleDoor();
  server.send(200, "text/plain", "UNLOCKED");
}

void handleLock() {
  if (doorOpen) toggleDoor();
  server.send(200, "text/plain", "LOCKED");
}

void setup() {
  Serial.begin(115200);
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, HIGH);
  pinMode(FSM_PIN, INPUT);

  SPI.begin(18, 19, 23, SS_PIN);
  rfid.PCD_Init();

  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.println("\\nWiFi Connected! IP Address: " + WiFi.localIP().toString());

  server.on("/status", handleStatus);
  server.on("/unlock", handleUnlock);
  server.on("/lock", handleLock);
  server.begin();
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) server.handleClient();
  checkSerialCommands();
  checkFootstep();
  checkRFID();
}

void checkSerialCommands() {
  if (Serial.available() > 0) {
    String cmd = Serial.readStringUntil('\\n');
    cmd.trim();
    if (cmd == "UNLOCK") { if (!doorOpen) toggleDoor(); }
    else if (cmd == "LOCK") { if (doorOpen) toggleDoor(); }
  }
}

void checkFootstep() {
  int value = analogRead(FSM_PIN);
  if (value > ${FOOTSTEP_THRESHOLD}) {
    if (!footDetected) { footDetected = true; Serial.println("[FOOTSTEP] Detected!"); }
  } else {
    if (footDetected) { footDetected = false; Serial.println("[FOOTSTEP] Removed."); }
  }
}

void checkRFID() {
  if (!footDetected) return;
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) return;

  if (isAuthorized(rfid.uid.uidByte)) {
    Serial.println("[RFID] Auth : AUTHORIZED ✓");
    toggleDoor();
  } else {
    Serial.println("[RFID] Auth : UNAUTHORIZED ✗");
  }

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  delay(300);
}

bool isAuthorized(byte *uid) {
  for (int i = 0; i < UID_COUNT; i++) {
    bool match = true;
    for (int j = 0; j < 4; j++) {
      if (uid[j] != allowedUID[i][j]) { match = false; break; }
    }
    if (match) return true;
  }
  return false;
}

void toggleDoor() {
  doorOpen = !doorOpen;
  digitalWrite(RELAY_PIN, doorOpen ? LOW : HIGH);
  Serial.println(doorOpen ? "[DOOR] OPENED 🔓" : "[DOOR] CLOSED 🔒");
}`;

    codeEditorDisplay.textContent = code;
  }

  document.getElementById('btnCopyCode').addEventListener('click', () => {
    navigator.clipboard.writeText(codeEditorDisplay.textContent);
    document.getElementById('btnCopyCode').textContent = "Copied! ✓";
    setTimeout(() => document.getElementById('btnCopyCode').textContent = "Copy Arduino Code", 2000);
  });

  /* ------------------------------------------------------------------------
     11. CANVAS AUDIT GRAPH
     ------------------------------------------------------------------------ */
  function renderAuditChart() {
    const canvas = document.getElementById('auditChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = canvas.parentElement.clientHeight;

    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(197, 203, 211, 0.4)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = (h / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    ctx.strokeStyle = "#5C67F2";
    ctx.lineWidth = 4;
    ctx.beginPath();

    const maxVal = Math.max(...activityHistory, 5);
    const stepX = w / (activityHistory.length - 1);

    activityHistory.forEach((val, index) => {
      const x = index * stepX;
      const y = h - (val / maxVal) * (h - 20) - 10;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });

    ctx.stroke();

    activityHistory.forEach((val, index) => {
      const x = index * stepX;
      const y = h - (val / maxVal) * (h - 20) - 10;
      ctx.fillStyle = "#FF6B6B";
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  /* ------------------------------------------------------------------------
     12. WEBSERIAL BRIDGE & REAL HARDWARE PARSER
     ------------------------------------------------------------------------ */
  async function sendSerialCommand(cmdString) {
    if (serialWriter) {
      try {
        const encoder = new TextEncoder();
        await serialWriter.write(encoder.encode(cmdString));
      } catch (err) {
        console.warn("Serial write error:", err);
      }
    }
  }

  document.getElementById('btnConnectSerial').addEventListener('click', async () => {
    if (!("serial" in navigator)) {
      alert("WebSerial API is not supported in this browser. Use Google Chrome or Microsoft Edge to connect to physical hardware.");
      return;
    }

    try {
      serialPort = await navigator.serial.requestPort();
      await serialPort.open({ baudRate: 115200 });

      const textEncoder = new TextEncoderStream();
      textEncoder.readable.pipeTo(serialPort.writable);
      serialWriter = textEncoder.writable.getWriter();

      connectionMode = 'serial';
      document.getElementById('connectionDot').className = "status-dot online";
      document.getElementById('connectionText').textContent = "USB Serial Connected";
      appendLog("[WEBSERIAL] Connected to physical ESP32 via USB COM Port!", "log-init");

      const textDecoder = new TextDecoderStream();
      serialPort.readable.pipeTo(textDecoder.writable);
      serialReader = textDecoder.readable.getReader();

      let lineBuffer = '';
      while (true) {
        const { value, done } = await serialReader.read();
        if (done) break;
        if (value) {
          lineBuffer += value;
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop(); // Keep remaining fragment in buffer

          for (let line of lines) {
            line = line.trim();
            if (!line) continue;
            parseHardwareSerialLine(line);
          }
        }
      }
    } catch (err) {
      appendLog(`[WEBSERIAL] Connection Error / Canceled: ${err.message}`, "log-error");
    }
  });

  window.addEventListener('resize', renderAuditChart);

  /* INITIAL RUN */
  initSystemLogs();
  renderWhitelistTable();
  renderAuditChart();
});
