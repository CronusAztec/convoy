/* Convoy — install self-hosted neural TTS (Piper) on the VPS.

   Usage (PowerShell), from the deploy/ folder:
     $env:VPS_HOST='2.25.184.90'; $env:VPS_USER='root'
     $env:VPS_KEY="$PWD\convoy_deploy_key"      # or $env:VPS_PASS='...'
     node setup-tts.js

   Installs the Piper binary + a female English voice (amy-medium) under
   /opt/convoy/tts, restarts the convoy service, and verifies /api/tts/health
   plus a sample synthesis. Idempotent — skips downloads that already exist.

   Optional: $env:TTS_MODEL_URL / $env:TTS_MODEL_NAME to use a different voice.
*/
'use strict';

const fs = require('fs');
const { Client } = require('ssh2');

const HOST = process.env.VPS_HOST;
const PASS = process.env.VPS_PASS;
const KEYFILE = process.env.VPS_KEY || '';
const USER = (process.env.VPS_USER || 'root').split(',')[0].trim();
const PRIVKEY = KEYFILE && fs.existsSync(KEYFILE) ? fs.readFileSync(KEYFILE) : null;

const PIPER_URL = process.env.PIPER_URL ||
  'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz';
const MODEL_NAME = process.env.TTS_MODEL_NAME || 'en_US-amy-medium';
const MODEL_BASE = process.env.TTS_MODEL_URL ||
  'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium';

if (!HOST || (!PASS && !PRIVKEY)) {
  console.error('Set VPS_HOST and VPS_KEY (or VPS_PASS).');
  process.exit(1);
}

function connect() {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on('ready', () => resolve(c));
    c.on('error', reject);
    if (PASS) c.on('keyboard-interactive', (n, i, l, p, finish) => finish(p.map(() => PASS)));
    const cfg = { host: HOST, port: 22, username: USER, readyTimeout: 25000 };
    if (PRIVKEY) cfg.privateKey = PRIVKEY;
    if (PASS) { cfg.password = PASS; cfg.tryKeyboard = true; }
    c.connect(cfg);
  });
}

// Run a bash script (base64 so quoting/newlines survive PS→node→ssh), streaming output.
function run(conn, script) {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const cmd = 'bash -c "$(echo ' + b64 + ' | base64 -d)"';
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('close', (code) => resolve({ code: code == null ? 0 : code, out }));
      stream.on('data', (d) => { out += d; process.stdout.write(d); });
      stream.stderr.on('data', (d) => { out += d; process.stdout.write(d); });
    });
  });
}

const SCRIPT = `
set -e
TTS=/opt/convoy/tts
mkdir -p $TTS/piper $TTS/models
cd /tmp
command -v curl >/dev/null || (apt-get update -qq && apt-get install -y -qq curl)

if [ ! -x $TTS/piper/piper ]; then
  echo "== downloading Piper binary =="
  curl -fsSL -o piper.tgz "${PIPER_URL}"
  tar -xzf piper.tgz -C $TTS/      # creates $TTS/piper/
  rm -f piper.tgz
else
  echo "== Piper binary already present =="
fi

M=$TTS/models
if [ ! -s $M/${MODEL_NAME}.onnx ]; then
  echo "== downloading voice model ${MODEL_NAME} =="
  curl -fsSL -o $M/${MODEL_NAME}.onnx "${MODEL_BASE}/${MODEL_NAME}.onnx?download=true"
  curl -fsSL -o $M/${MODEL_NAME}.onnx.json "${MODEL_BASE}/${MODEL_NAME}.onnx.json?download=true"
else
  echo "== voice model already present =="
fi

chown -R convoy:convoy $TTS
echo "== files =="
ls -la $TTS/piper/piper $M/${MODEL_NAME}.onnx 2>&1 | sed 's/  */ /g'

echo "== smoke test (synthesize to WAV) =="
ESPK=""; [ -d $TTS/piper/espeak-ng-data ] && ESPK="--espeak_data $TTS/piper/espeak-ng-data"
echo "Convoy navigation is online." | LD_LIBRARY_PATH=$TTS/piper $TTS/piper/piper --model $M/${MODEL_NAME}.onnx --output_file /tmp/tts_test.wav $ESPK 2>/tmp/piper.err || { echo "PIPER FAILED:"; cat /tmp/piper.err; exit 1; }
WAVSZ=$(stat -c%s /tmp/tts_test.wav 2>/dev/null || echo 0)
echo "wav bytes: $WAVSZ"; head -c4 /tmp/tts_test.wav | od -An -c | tr -d '\\n'; echo " (expect RIFF)"
rm -f /tmp/tts_test.wav

echo "== set TTS_MODEL in the systemd unit if not auto-detected =="
UNIT=/etc/systemd/system/convoy.service
if ! grep -q "TTS_MODEL=" $UNIT; then
  sed -i "/Environment=NEARBY_KM/a Environment=TTS_MODEL=$M/${MODEL_NAME}.onnx" $UNIT 2>/dev/null || \
  sed -i "/ExecStart=/i Environment=TTS_MODEL=$M/${MODEL_NAME}.onnx" $UNIT
  systemctl daemon-reload
fi

systemctl restart convoy
sleep 1.5
PORT=$(grep -oP 'PORT=\\K[0-9]+' $UNIT | head -1); PORT=\${PORT:-5173}
echo "== /api/tts/health (port $PORT) =="
curl -s -m 5 http://127.0.0.1:$PORT/api/tts/health; echo
echo "== /api/tts sample → bytes =="
curl -s -m 10 -o /tmp/srv_tts.wav "http://127.0.0.1:$PORT/api/tts?text=Turn%20left%20in%20300%20feet" && stat -c '%s bytes' /tmp/srv_tts.wav && head -c4 /tmp/srv_tts.wav | od -An -c | tr -d '\\n' && echo " (expect RIFF)"; rm -f /tmp/srv_tts.wav
systemctl is-active convoy
echo DONE
`;

(async () => {
  const conn = await connect();
  console.log('Connected to ' + HOST + ' as ' + USER + ' — installing Piper TTS...\n');
  const r = await run(conn, SCRIPT);
  conn.end();
  console.log('\n' + (r.out.indexOf('DONE') >= 0 && /RIFF/.test(r.out)
    ? 'PASS — Piper neural TTS installed and synthesizing on the server.'
    : 'Check the output above — install or synth may have failed.'));
  process.exit(0);
})().catch((e) => { console.error('Aborted: ' + e.message); process.exit(2); });
