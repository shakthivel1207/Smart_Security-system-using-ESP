#include <SPI.h>
#include <MFRC522.h>

#define FSM_PIN     34
#define RELAY_PIN   14

#define SS_PIN      5
#define RST_PIN     22

MFRC522 rfid(SS_PIN, RST_PIN);

/* ---------- STATE ---------- */
bool footDetected = false;
bool doorOpen = false;

/* ---------- AUTHORIZED RFID TAGS ---------- */
byte allowedUID[][4] = {
  {0x92, 0x69, 0xF6, 0x05},
  {0x12, 0x34, 0x56, 0x78}
};

#define UID_COUNT (sizeof(allowedUID) / sizeof(allowedUID[0]))

void setup() {
  Serial.begin(115200);

  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, HIGH);

  Serial.println("========================================");
  Serial.println("       RFID DOOR CONTROL SYSTEM        ");
  Serial.println("========================================");
  Serial.print("Relay Pin     : GPIO "); Serial.println(RELAY_PIN);
  Serial.print("FSM Pin       : GPIO "); Serial.println(FSM_PIN);
  Serial.print("RFID SS Pin   : GPIO "); Serial.println(SS_PIN);
  Serial.print("RFID RST Pin  : GPIO "); Serial.println(RST_PIN);
  Serial.print("Allowed UIDs  : "); Serial.println(UID_COUNT);

  for (int i = 0; i < UID_COUNT; i++) {
    Serial.print("  ["); Serial.print(i); Serial.print("] ");
    for (int j = 0; j < 4; j++) {
      if (allowedUID[i][j] < 0x10) Serial.print("0");
      Serial.print(allowedUID[i][j], HEX);
      if (j < 3) Serial.print(":");
    }
    Serial.println();
  }

  SPI.begin();
  rfid.PCD_Init();

  Serial.println("----------------------------------------");
  Serial.println("[INIT] SPI        : OK");
  Serial.println("[INIT] MFRC522    : OK");
  Serial.println("[INIT] Relay      : HIGH (LOCKED)");
  Serial.println("[INIT] Door State : LOCKED");
  Serial.println("========================================");
  Serial.println("System Ready. Waiting for footstep...");
  Serial.println("========================================");
}

void loop() {
  checkFootstep();
  checkRFID();
}

/* ---------- FOOTSTEP ---------- */
void checkFootstep() {
  int value = analogRead(FSM_PIN);

  if (value > 1500) {
    if (!footDetected) {
      footDetected = true;
      Serial.println("----------------------------------------");
      Serial.println("[FOOTSTEP] Detected!");
      Serial.print  ("[FOOTSTEP] Sensor Value : "); Serial.println(value);
      Serial.println("[FOOTSTEP] RFID Scanner : ENABLED");
      Serial.println("[FOOTSTEP] Please scan your RFID card.");
      Serial.println("----------------------------------------");
    }
  } else {
    if (footDetected) {
      footDetected = false;
      Serial.println("----------------------------------------");
      Serial.println("[FOOTSTEP] Removed.");
      Serial.print  ("[FOOTSTEP] Sensor Value : "); Serial.println(value);
      Serial.println("[FOOTSTEP] RFID Scanner : DISABLED");
      Serial.println("----------------------------------------");
    }
  }
}

/* ---------- RFID ---------- */
void checkRFID() {
  if (!footDetected) return;

  if (!rfid.PICC_IsNewCardPresent()) return;
  if (!rfid.PICC_ReadCardSerial())   return;

  Serial.println("----------------------------------------");
  Serial.println("[RFID] Card Detected!");

  /* ---- UID ---- */
  Serial.print("[RFID] UID (HEX) : ");
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) Serial.print("0");
    Serial.print(rfid.uid.uidByte[i], HEX);
    if (i < rfid.uid.size - 1) Serial.print(":");
  }
  Serial.println();

  Serial.print("[RFID] UID (DEC) : ");
  for (byte i = 0; i < rfid.uid.size; i++) {
    Serial.print(rfid.uid.uidByte[i], DEC);
    if (i < rfid.uid.size - 1) Serial.print(".");
  }
  Serial.println();

  Serial.print("[RFID] UID Size  : ");
  Serial.print(rfid.uid.size);
  Serial.println(" bytes");

  Serial.print("[RFID] SAK       : 0x");
  if (rfid.uid.sak < 0x10) Serial.print("0");
  Serial.println(rfid.uid.sak, HEX);

  /* ---- Auth ---- */
  if (isAuthorized(rfid.uid.uidByte)) {
    Serial.println("[RFID] Auth      : AUTHORIZED ✓");
    toggleDoor();
  } else {
    Serial.println("[RFID] Auth      : UNAUTHORIZED ✗");
    Serial.println("[DOOR] No action taken.");
  }

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  Serial.println("[RFID] Card halted. Ready for next scan.");
  Serial.println("----------------------------------------");

  delay(300);
}

/* ---------- UID CHECK ---------- */
bool isAuthorized(byte *uid) {
  for (int i = 0; i < UID_COUNT; i++) {
    bool match = true;
    for (int j = 0; j < 4; j++) {
      if (uid[j] != allowedUID[i][j]) { match = false; break; }
    }
    if (match) {
      Serial.print("[RFID] Matched whitelist entry [");
      Serial.print(i);
      Serial.println("]");
      return true;
    }
  }
  return false;
}

/* ---------- DOOR TOGGLE ---------- */
void toggleDoor() {
  doorOpen = !doorOpen;

  Serial.println("----------------------------------------");
  if (doorOpen) {
    digitalWrite(RELAY_PIN, LOW);
    Serial.println("[RELAY] Switched : HIGH → LOW");
    Serial.println("[RELAY] State    : ENERGIZED (ON)");
    Serial.println("[DOOR]  State    : OPENED  🔓");
    Serial.println("[DOOR]  Lock     : DISENGAGED");
  } else {
    digitalWrite(RELAY_PIN, HIGH);
    Serial.println("[RELAY] Switched : LOW → HIGH");
    Serial.println("[RELAY] State    : DE-ENERGIZED (OFF)");
    Serial.println("[DOOR]  State    : CLOSED  🔒");
    Serial.println("[DOOR]  Lock     : ENGAGED");
  }
  Serial.print("[DOOR]  Toggle # : ");
  Serial.println(doorOpen ? "Unlock event" : "Lock event");
  Serial.println("----------------------------------------");
}