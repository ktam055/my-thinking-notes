// ブラウザ標準の音声認識（Web Speech API）。Chrome / Edge（Windows・Android）で動作。
export function createRecognizer({ onText, onState, onError }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;

  const rec = new SR();
  rec.lang = "ja-JP";
  rec.continuous = true;
  rec.interimResults = true;
  let active = false;

  rec.onresult = (e) => {
    let finalText = "";
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    onText(finalText.trim(), interim.trim());
  };
  rec.onerror = (e) => {
    const msg = {
      "not-allowed": "マイクの使用が許可されていません",
      "no-speech": "音声が聞き取れませんでした",
      network: "音声認識の通信エラーです",
    }[e.error] || `音声認識エラー: ${e.error}`;
    if (e.error !== "aborted") onError(msg);
  };
  rec.onend = () => {
    // Android では数秒の無音で止まるので、ユーザーが止めるまで再開する
    if (active) { try { rec.start(); return; } catch { /* fallthrough */ } }
    active = false;
    onState(false);
  };

  return {
    toggle() { active ? this.stop() : this.start(); },
    start() {
      active = true;
      try { rec.start(); } catch { /* already started */ }
      onState(true);
    },
    stop() {
      if (!active) return;
      active = false;
      rec.stop();
    },
  };
}
