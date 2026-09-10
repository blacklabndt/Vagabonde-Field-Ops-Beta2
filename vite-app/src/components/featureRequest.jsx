import { useState } from "react";
import { Db } from "../db.js";
import { Toasts } from "../toastBus.js";
import { Dialog, Field, Btn, ErrorBox } from "./common.jsx";

// The drawer's Feature request form: a title and the details, mailed to
// the owner with the sender's name on top. The function fixes the
// recipient, so the form carries no address of its own.
//
// A send that fails keeps the words in the dialog — a message typed in a
// truck with a poor signal is not something to make anyone type twice.
export function FeatureRequestDialog({ onClose }) {
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const send = async () => {
    if (!title.trim()) { setError("Give the request a title."); return; }
    if (!details.trim()) { setError("Say what you would like the app to do."); return; }
    setSending(true);
    setError("");
    try {
      await Db.sendFeatureRequest({ title: title.trim(), details: details.trim() });
      Toasts.show("Sent — thanks, it has gone to the office.");
      onClose();
    } catch (e) {
      setSending(false);
      setError(e.networkFailure
        ? "No connection — your words are still here, try again when you have signal."
        : (e.message || "It could not be sent."));
    }
  };

  return (
    <Dialog title="Feature request" maxWidth={520} onClose={onClose}
      actions={<>
        <Btn variant="secondary" onClick={onClose} disabled={sending}>Cancel</Btn>
        <Btn variant="primary" onClick={send} disabled={sending}>{sending ? "Sending…" : "Send"}</Btn>
      </>}>
      <ErrorBox>{error}</ErrorBox>
      <Field label="What would you like?" required>
        <input className="input" value={title} maxLength={120} placeholder="A line that says it"
          onChange={e => { setError(""); setTitle(e.target.value); }} />
      </Field>
      <Field label="Tell us more" required>
        <textarea className="input" value={details} maxLength={4000} rows={7}
          placeholder="What you were trying to do, what got in the way, and what would help"
          onChange={e => { setError(""); setDetails(e.target.value); }} />
      </Field>
    </Dialog>
  );
}
