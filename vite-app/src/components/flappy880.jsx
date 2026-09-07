// An easter egg. Double-click your own name in the drawer.
//
// A Delta 880 is the exposure device the crew carries — the yellow crank-out
// camera that puts the source down the guide tube. Here it flies, and the
// obstacles are pipe joints, which is the joke: the whole app exists to
// radiograph welds on pipe, and Flappy Bird's obstacles were always pipes.
//
// Loaded as its own chunk and only when somebody finds it, so a technician on
// field data never pays a byte for it. It forgets everything when the dialog
// closes except two numbers: the local best in localStorage, because losing a
// good run to a page reload would be genuinely annoying, and the crew
// leaderboard in flappy_scores — the one table this touches, one best per
// person, written on crash and never through the offline queue. A score is
// not work; it does not get to compete with a ticket for a sync slot.

import React, { useRef, useEffect, useState, useCallback } from "react";
import { Btn } from "./common.jsx";
import { Store } from "../data.js";
import { Db } from "../db.js";

const W = 360;                 // canvas units; the element scales to fit
const H = 520;
const GRAVITY = 1500;          // px/s² — tuned by playing it, not by theory
const FLAP = -430;             // px/s, straight up
const SPEED = 132;             // px/s the pipes travel left
const GAP = 148;               // vertical opening between pipe joints
const PIPE_W = 62;
const SPACING = 210;           // px between one pipe pair and the next
const DEVICE_X = 96;
const DEVICE_W = 60;           // wide and low, the way the real one stands
const DEVICE_H = 37;
const BEST_KEY = "flappy880.best";

// The Sentinel 880 Delta, kept to the flat style the rest of the scene uses:
// solid fills, one shadow tone, one dark outline. What makes the real device
// recognisable is its anatomy rather than its shading, and drawn from its
// side profile that anatomy is: a wide, low, one-piece yellow frame whose
// carry handle is part of the moulding; side lobes that bulge out past the
// tube and wrap around it; a concave underside arching between two feet; and
// the stainless source tube sitting inside the frame, nearly as tall as it,
// wearing the yellow radioactive label. Drawn rather than an image so it
// stays sharp at any size and adds nothing to the download.
//
// Coordinates are fractions of the sprite box, so retuning DEVICE_W/H does
// not mean redrawing the thing.
function drawDevice(g, x, y, tilt) {
  g.save();
  g.translate(x + DEVICE_W / 2, y + DEVICE_H / 2);
  g.rotate(tilt);
  g.translate(-DEVICE_W / 2, -DEVICE_H / 2);

  const W = DEVICE_W, H = DEVICE_H;
  const YEL = "#efb01d", YEL_LO = "#c2870f";
  const STEEL = "#c2cbd1", STEEL_LO = "#8a959c";
  const INK = "#34393c";

  g.lineJoin = "round";
  g.lineCap = "round";
  g.strokeStyle = INK;
  g.lineWidth = Math.max(1, W * 0.03);

  // Guide tube, trailing off the back — the source runs out through this.
  g.save();
  g.strokeStyle = "#4c5052";
  g.lineWidth = Math.max(1.4, W * 0.045);
  g.beginPath();
  g.moveTo(W * 0.08, H * 0.6);
  g.quadraticCurveTo(-W * 0.12, H * 0.5, -W * 0.26, H * 0.88);
  g.stroke();
  g.restore();

  // The tube sits inside the frame, so it is drawn first and deliberately
  // oversized: the frame goes on top and the steel shows only through the
  // window in it. Painting the tube last made it look stuck on the front.
  // The tube is wrapped end to end in the bright yellow radioactive label,
  // with the trefoil dead centre. Drawn oversized so the frame covers its
  // edges and it reads as passing behind the moulding.
  g.fillStyle = "#f7d400";
  g.fillRect(W * 0.20, H * 0.30, W * 0.56, H * 0.49);
  g.fillStyle = "#d4ac00";                    // underside, for a little curvature
  g.fillRect(W * 0.20, H * 0.68, W * 0.56, H * 0.11);

  // The seam along the very top edge of the label. Drawn full width and left
  // for the frame to crop, so it stops where the moulding covers the tube.
  g.beginPath();
  g.moveTo(W * 0.20, H * 0.31);
  g.lineTo(W * 0.76, H * 0.31);
  g.stroke();

  // A real trefoil rather than a dot: three blades round a hub. At sprite
  // size it collapses into a magenta blob anyway, which is the right thing
  // for it to collapse into.
  const tr = Math.max(1.6, H * 0.13);
  g.fillStyle = "#a4208c";
  g.beginPath();
  g.arc(W * 0.48, H * 0.53, tr * 0.3, 0, Math.PI * 2);
  g.fill();
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + i * (Math.PI * 2 / 3);
    g.beginPath();
    g.moveTo(W * 0.48, H * 0.53);
    g.arc(W * 0.48, H * 0.53, tr, a - 0.5, a + 0.5);
    g.closePath();
    g.fill();
  }

  // The yellow frame: one moulded piece, wide and low, the handle part of
  // the moulding rather than a separate arch. Two subpaths are punched out
  // with the even-odd rule — the gap under the handle, and the window the
  // tube shows through.
  const framePath = () => {
    g.beginPath();
    // outer silhouette, clockwise from the inner edge of the left foot
    g.moveTo(W * 0.20, H);
    g.lineTo(W * 0.05, H);
    g.quadraticCurveTo(W * 0.005, H * 0.99, W * 0.01, H * 0.90);
    // sides run down and out in a near-straight taper to the feet, which is
    // where it is widest; curving them out at mid-height made it a blob
    g.bezierCurveTo(W * 0.04, H * 0.62, W * 0.10, H * 0.44, W * 0.19, H * 0.28);
    g.bezierCurveTo(W * 0.21, H * 0.13, W * 0.24, 0, W * 0.30, 0);
    g.lineTo(W * 0.70, 0);
    g.bezierCurveTo(W * 0.76, 0, W * 0.79, H * 0.13, W * 0.81, H * 0.28);
    g.bezierCurveTo(W * 0.90, H * 0.44, W * 0.96, H * 0.62, W * 0.99, H * 0.90);
    g.quadraticCurveTo(W * 0.995, H * 0.99, W * 0.95, H);
    g.lineTo(W * 0.80, H);
    // the concave underside, arching up between the two feet
    g.bezierCurveTo(W * 0.71, H * 0.92, W * 0.61, H * 0.87, W * 0.5, H * 0.87);
    g.bezierCurveTo(W * 0.39, H * 0.87, W * 0.29, H * 0.92, W * 0.20, H);
    g.closePath();
    // One continuous opening, not two. The handle arches straight over the
    // tube on the real device — there is no plastic cross-member between the
    // grip and the steel, so punching two holes with a bar between them was
    // inventing a part. Sky shows in the upper, narrow part; the tube fills
    // the lower, wider part where the opening flares out to its full width.
    g.moveTo(W * 0.36, H * 0.10);
    g.quadraticCurveTo(W * 0.5, H * 0.06, W * 0.64, H * 0.10);
    // a single straight chamfer out to the tube on each side, rather than the
    // two-segment corner that read as a hook
    g.lineTo(W * 0.72, H * 0.31);
    g.lineTo(W * 0.72, H * 0.72);
    g.quadraticCurveTo(W * 0.72, H * 0.75, W * 0.69, H * 0.75);
    g.lineTo(W * 0.27, H * 0.75);
    g.quadraticCurveTo(W * 0.24, H * 0.75, W * 0.24, H * 0.72);
    g.lineTo(W * 0.24, H * 0.31);
    g.closePath();
  };

  framePath();
  g.fillStyle = YEL;
  g.fill("evenodd");

  // one shadow tone along the feet, no gradients. Clipped with the same rule
  // so it lands on yellow and not on the steel showing through the window.
  g.save();
  framePath();
  g.clip("evenodd");
  g.fillStyle = YEL_LO;
  g.fillRect(0, H * 0.86, W, H * 0.14);
  g.restore();

  framePath();
  g.stroke();

  // The circular port in the side lobe, and a fastener on the other. The
  // port is a hole through the moulding, so it is black rather than a
  // shaded yellow — as a brown dot it read as a smudge on the plastic.
  g.fillStyle = "#1e2123";
  g.beginPath(); g.arc(W * 0.875, H * 0.64, Math.max(1, H * 0.085), 0, Math.PI * 2); g.fill();
  g.fillStyle = YEL_LO;
  g.beginPath(); g.arc(W * 0.13, H * 0.48, Math.max(0.8, H * 0.045), 0, Math.PI * 2); g.fill();

  g.restore();
}

// A pipe joint: the pipe itself plus a weld cap at the opening, so the thing
// being dodged looks like the thing being radiographed.
// The gradient is built once per context (see the effect below) and the
// pipe drawn under a translate, which is pixel-identical to a gradient
// minted at x — six of them a frame at 60 fps was allocation for nothing.
function drawPipe(g, grad, x, top, height, flip) {
  g.save();
  g.translate(x, 0);
  g.fillStyle = grad;
  g.fillRect(0, top, PIPE_W, height);
  g.strokeStyle = "#4d565c";
  g.lineWidth = 2;
  g.strokeRect(0, top, PIPE_W, height);

  // the weld cap at the open end
  const capY = flip ? top + 4 : top + height - 14;
  g.fillStyle = "#95a0a7";
  g.fillRect(-4, capY, PIPE_W + 8, 10);
  g.strokeRect(-4, capY, PIPE_W + 8, 10);
  g.restore();
}

// The two gradients the scene uses, made once for a context. Their
// coordinates are constants; a setTransform does not invalidate them.
function makeGradients(g) {
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#cfe0ec");
  sky.addColorStop(1, "#eef2f4");
  const pipe = g.createLinearGradient(0, 0, PIPE_W, 0);
  pipe.addColorStop(0, "#7d8890");
  pipe.addColorStop(0.35, "#aeb8bf");
  pipe.addColorStop(1, "#6d777e");
  return { sky, pipe };
}

export function Flappy880({ onClose, me }) {
  const canvasRef = useRef(null);
  const [best, setBest] = useState(() => Number(Store.load(BEST_KEY, 0)) || 0);
  const [score, setScore] = useState(0);
  const [state, setState] = useState("ready");     // ready | flying | crashed
  const [board, setBoard] = useState(null);        // null until the first crash
  const [boardNote, setBoardNote] = useState("");

  // Posting the score and reading the board back. Kept behind a ref because
  // the game loop below is created once with an empty dependency list, so a
  // callback captured directly would be the one from the first render.
  const submit = useCallback(async runScore => {
    try {
      if (me && me.id && runScore > 0) await Db.saveArcadeScore({ game: "flappy880", profileId: me.id, best: runScore });
      setBoard(await Db.listArcadeScores("flappy880"));
      setBoardNote("");
    } catch {
      // A leaderboard is not worth an error dialog over. Offline, or the
      // table is not there yet: say so quietly and let them keep playing.
      setBoardNote("Scoreboard unavailable.");
    }
  }, [me]);
  const submitRef = useRef(submit);
  submitRef.current = submit;

  // Everything the loop mutates lives in a ref, not in state: a game loop that
  // re-renders React sixty times a second is a game loop that drops frames.
  const game = useRef({ y: H / 2, vy: 0, pipes: [], score: 0, t: 0 });
  const stateRef = useRef(state);
  stateRef.current = state;

  // A frame can detect more than one collision — two pipes overlapping the
  // device, or a pipe and the ground — and setState does not land until the
  // next render, so stateRef is still "flying" for all of them. That was
  // harmless when crashing only set some state; now that it posts a score it
  // would have fired several writes for one crash.
  const dead = useRef(false);

  const reset = useCallback(() => {
    game.current = { y: H / 2, vy: 0, pipes: [], score: 0, t: 0 };
    dead.current = false;
    setScore(0);
    setState("ready");
  }, []);

  const flap = useCallback(() => {
    if (stateRef.current === "crashed") { reset(); return; }
    if (stateRef.current === "ready") setState("flying");
    game.current.vy = FLAP;
  }, [reset]);

  // Space and the up arrow, and not while somebody is typing somewhere else.
  // The guard is not hypothetical: the egg never steals focus, so a search
  // box behind the dialog can still own the keyboard, and preventDefault
  // here would silently eat every space typed into it.
  useEffect(() => {
    const onKey = e => {
      // Escape is this game's alone while it is open: heard in the capture
      // phase and stopped there, so the drawer's own bubble-phase listener
      // (the egg opens from inside the drawer) doesn't close the drawer too.
      if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === " " || e.key === "ArrowUp") {
        e.preventDefault();                   // the page must not scroll
        if (!e.repeat) flap();                // holding the key down is not flying
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [flap, onClose]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const g = canvas.getContext("2d");
    const grads = makeGradients(g);

    // Match the pixel buffer to the screen's actual pixels. A fixed 360x520
    // buffer on a phone at devicePixelRatio 3 is one canvas pixel smeared
    // across nine, which does not read as "blurry" so much as washed out —
    // every edge in the drawing gets averaged with its neighbours. Capped at
    // 3 so a very dense screen does not allocate a buffer for no visible gain.
    //
    // Setting canvas.width wipes the context, transform included, so the
    // scale has to go on afterwards and again on every refit.
    let lastDpr = 0;
    // Whether the crashed board's one still has been painted since the
    // buffer was last wiped — see step().
    let crashPainted = false;
    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      // Mobile browsers fire resize when the URL bar collapses, dozens of
      // times per scroll. Setting canvas.width wipes the frame even at the
      // same value, so only a ratio that actually changed gets a new buffer.
      if (dpr === lastDpr) return;
      lastDpr = dpr;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      // The buffer was just wiped; a crashed board must be painted again.
      crashPainted = false;
    };
    fit();
    window.addEventListener("resize", fit);   // moving to another monitor can change it

    let raf = 0;
    let last = performance.now();
    let stopped = false;

    const step = now => {
      if (stopped) return;
      // Clamped: a backgrounded tab hands back a delta of several seconds,
      // and the device would teleport through a pipe on the first frame back.
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const s = game.current;

      if (stateRef.current === "flying") {
        s.t += dt;
        s.vy += GRAVITY * dt;
        s.y += s.vy * dt;

        // spawn and advance pipes
        const lastPipe = s.pipes[s.pipes.length - 1];
        if (!lastPipe || lastPipe.x < W - SPACING) {
          const margin = 54;
          s.pipes.push({ x: W + PIPE_W, gapY: margin + Math.random() * (H - GAP - margin * 2), passed: false });
        }
        for (const p of s.pipes) p.x -= SPEED * dt;
        while (s.pipes.length && s.pipes[0].x < -PIPE_W - 10) s.pipes.shift();

        // scoring and collisions
        const dx = DEVICE_X, dw = DEVICE_W, dh = DEVICE_H;
        for (const p of s.pipes) {
          if (!p.passed && p.x + PIPE_W < dx) { p.passed = true; s.score++; setScore(s.score); }
          const overlapX = dx + dw > p.x && dx < p.x + PIPE_W;
          const throughGap = s.y > p.gapY && s.y + dh < p.gapY + GAP;
          if (overlapX && !throughGap) crash();
        }
        if (s.y + dh >= H - 26 || s.y <= 0) crash();
      }

      // A crashed board is a still: it is painted once and then left, rather
      // than repainted sixty times a second for as long as it sits open.
      if (stateRef.current === "crashed") {
        if (!crashPainted) { crashPainted = true; draw(g); }
      } else {
        crashPainted = false;
        draw(g);
      }
      raf = requestAnimationFrame(step);
    };

    const crash = () => {
      if (dead.current) return;
      dead.current = true;
      setState("crashed");
      const s = game.current;
      // The local best still stands on its own: it is what the footer reads
      // and it keeps working with no signal, which the scoreboard does not.
      if (s.score > (Number(Store.load(BEST_KEY, 0)) || 0)) {
        Store.save(BEST_KEY, s.score);
        setBest(s.score);
      }
      setBoardNote("");
      submitRef.current(s.score);
    };

    const draw = g2 => {
      const s = game.current;

      // sky over a prairie horizon — it is Grande Prairie, after all
      g2.fillStyle = grads.sky;
      g2.fillRect(0, 0, W, H);

      for (const p of s.pipes) {
        drawPipe(g2, grads.pipe, p.x, 0, p.gapY, true);
        drawPipe(g2, grads.pipe, p.x, p.gapY + GAP, H - (p.gapY + GAP) - 26, false);
      }

      // ground
      g2.fillStyle = "#8a8f78";
      g2.fillRect(0, H - 26, W, 26);
      g2.fillStyle = "#767c66";
      for (let i = 0; i < W; i += 18) {
        const off = (i - (s.t * SPEED) % 18);
        g2.fillRect(off, H - 26, 9, 4);
      }

      const tilt = Math.max(-0.5, Math.min(1.1, s.vy / 620));
      drawDevice(g2, DEVICE_X, s.y, stateRef.current === "ready" ? 0 : tilt);

      // Outlined, because the score sits wherever the next pipe happens to be
      // and a flat dark digit disappears against grey steel.
      g2.font = "600 30px Helvetica, Arial, sans-serif";
      g2.textAlign = "center";
      g2.lineWidth = 5;
      g2.strokeStyle = "#f4f7f8";
      g2.strokeText(String(s.score), W / 2, 56);
      g2.fillStyle = "#1d1f20";
      g2.fillText(String(s.score), W / 2, 56);
    };

    raf = requestAnimationFrame(step);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", fit);
    };
  }, []);

  return (
    <div className="egg-backdrop" onClick={onClose}>
      <div className="egg-box" onClick={e => e.stopPropagation()}>
        <div className="egg-head">
          <strong>Flappy 880</strong>
          <span>Mind the welds.</span>
          <Btn variant="ghost" style={{ marginLeft: "auto" }} onClick={onClose}>Close</Btn>
        </div>

        <div className="egg-stage">
          {/* No width/height here on purpose: the effect sizes the buffer to
              the device pixel ratio, and a React-managed attribute alongside
              that is just two things claiming the same property. CSS gives it
              its on-screen size either way. */}
          <canvas
            ref={canvasRef}
            className="egg-canvas"
            onPointerDown={e => { e.preventDefault(); flap(); }}
            aria-label="Flappy 880, a small game. Press space to fly."
            role="img"
          />

          {/* The board, over the wreckage. It ignores pointers entirely so a
              tap anywhere still restarts — reaching around a panel to find
              the canvas is not something anyone should have to work out. */}
          {state === "crashed" && (
            <div className="egg-board">
              <strong>Best runs</strong>
              {boardNote ? <p className="egg-board-note">{boardNote}</p>
                : !board ? <p className="egg-board-note">Loading…</p>
                : board.length === 0 ? <p className="egg-board-note">Nobody has scored yet.</p>
                : (
                  <ol>
                    {board.map((r, i) => (
                      <li key={r.id} className={me && r.id === me.id ? "mine" : ""}>
                        <span className="pos">{i + 1}</span>
                        <span className="who">{r.name || "—"}</span>
                        <span className="pts">{r.best}</span>
                      </li>
                    ))}
                  </ol>
                )}
            </div>
          )}
        </div>

        <div className="egg-foot">
          <span>{state === "crashed" ? "Source stuck. Tap to try again." : "Tap or press space"}</span>
          <span style={{ marginLeft: "auto" }}>Best {best}</span>
        </div>
      </div>
    </div>
  );
}
