import { Dialog, Btn } from "./common.jsx";
import { helpFor } from "../help.js";

// The tip that meets you on a screen: what the screen is for, what its
// buttons do, and the rules that catch people out, written out in help.js.
// "Ok" closes it for this run of the app — the screen says it again the
// next time the app is opened, and the other screens still say theirs in
// the meantime. "No more tips" is the kill switch: no screen, ever again.
//
// It reads the screen key rather than being told what to say, so the tip
// and the section name in the bar can never disagree: they are the same
// `screen` value.
//
// Nothing is fetched and nothing is written here. A person meeting a screen
// for the first time may well have no signal, which is the whole reason the
// words are shipped with the app instead of living in the repository's
// markdown.
export function HelpTip({ screenKey, onOk, onNoMore }) {
  const entry = helpFor(screenKey);
  // App.jsx already asks helpFor before raising this; the same answer given
  // twice, so a future caller cannot open an empty popup somebody then has
  // to work out how to close.
  if (!entry) return null;

  return (
    <Dialog title={entry.heading} maxWidth={620} onClose={onOk} focusFirst={false}
      actions={<>
        {/* The quiet one first, the way out on the right where the thumb
            is. Both close the popup; only one of them closes the rest. */}
        <Btn variant="secondary" onClick={onNoMore}>No more tips</Btn>
        <Btn variant="primary" onClick={onOk}>Ok</Btn>
      </>}>
      {/* Paragraphs, not a list: these are sentences about how the screen
          behaves, and bullets would invite them to be trimmed to fragments
          that no longer say why. The line height is loose because this is
          read on a phone, in daylight, standing up. */}
      {entry.body.map((para, i) => (
        <p key={i} style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>{para}</p>
      ))}
    </Dialog>
  );
}
