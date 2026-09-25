/*
  dropdown.js — Shared, viewport-aware dropdown positioning + behavior.

  Used by content.js to drive the mode-selector menu, but written with no
  knowledge of modes, prompts, or any specific site — it just knows how to
  make ONE trigger + ONE menu element behave like a robust dropdown.

  KEY IDEA — the menu is a "portal":
    Chat sites routinely wrap their input in a container with
    `overflow: hidden` / `overflow: clip` (ChatGPT's composer surface and
    Gemini's input row both do this — confirmed by inspecting their live
    DOM). If our dropdown menu were a normal descendant of that container,
    it would get silently clipped the moment it needed to extend past the
    container's edge — which is exactly the "options get cut off" bug this
    file exists to fix.

    So instead, the menu element is moved onto `document.body` the first
    time this is called, positioned with `position: fixed` using
    coordinates computed from the trigger's real `getBoundingClientRect()`.
    `position: fixed` measures from the viewport, not from any ancestor —
    so no ancestor's overflow, transform, or scroll position can clip or
    misplace it (as long as no ancestor between body and the menu creates
    its own containing block, which a direct child of <body> never does).

  Python analogy: this is like popping a Tkinter widget into its own
  top-level window instead of trying to cram it inside a parent frame
  that's too small for it — position it in screen coordinates, not
  relative to a cramped parent.
*/

const PB_DROPDOWN_GAP = 8;       // space between trigger and menu
const PB_VIEWPORT_PAD = 8;       // keep the menu clear of the viewport edge
const PB_MIN_MENU_HEIGHT = 120;  // don't shrink the scroll area below this
const PB_MAX_MENU_HEIGHT = 420;  // don't let it get absurdly tall either

/*
  pbCreateDropdown(trigger, menu) wires `menu` up as a portal-based
  dropdown anchored to `trigger`. Returns { open, close, toggle, isOpen,
  reposition, destroy }.

  Positioning is recalculated:
    - every time the menu opens (fresh getBoundingClientRect of both the
      trigger and the menu's own natural size)
    - on window resize, while open
    - on scroll of ANY scrollable ancestor, while open (via a capturing
      listener — 'scroll' doesn't bubble, so capture on document is the
      only way to hear about an inner container scrolling, not just the
      window)
  All listeners are attached on open and removed on close — nothing here
  is a permanent global listener.
*/
function pbCreateDropdown(trigger, menu) {
  // `isOpen` is a normal local variable — but because every function
  // declared below (place, open, close, toggle, ...) is defined INSIDE
  // pbCreateDropdown, they all get to keep reading and writing this same
  // `isOpen` even after pbCreateDropdown itself has finished running and
  // returned. That's called a CLOSURE: each function "closes over" the
  // variables from the scope it was born in. It's how we get something
  // that behaves like a private instance variable in a class, without
  // needing a class at all — every call to pbCreateDropdown() creates a
  // fresh, independent `isOpen` that only THIS dropdown's functions share.
  let isOpen = false;

  // Portal: move the menu to <body> once, and keep it position:fixed at
  // all times (even while "closed") so its box always has real, measurable
  // dimensions — closed state is expressed with visibility/opacity/
  // pointer-events (see .pb-menu-portal in content.css), never
  // display:none, precisely so `menu.scrollHeight` / `offsetWidth` stay
  // accurate for the next open() without an extra measurement step.
  document.body.appendChild(menu);
  menu.classList.add('pb-menu-portal');

  function place() {
    // getBoundingClientRect() is a built-in method every DOM element has.
    // It returns an object like:
    //   { top: 120, bottom: 148, left: 40, right: 180, width: 140, height: 28, x: 40, y: 120 }
    // — the element's CURRENT on-screen pixel position and size, measured
    // from the top-left corner of the browser window. It changes every
    // time the page scrolls or reflows, so we always ask for a fresh one
    // right before using it rather than caching it.
    const triggerRect = trigger.getBoundingClientRect();

    // document.documentElement is the <html> element. Its clientWidth/
    // clientHeight give the visible viewport size in CSS pixels, EXCLUDING
    // any scrollbar — which is exactly "how much room is actually visible
    // to the user right now," the number we want for collision math.
    const viewportW = document.documentElement.clientWidth;
    const viewportH = document.documentElement.clientHeight;

    const spaceBelow = viewportH - triggerRect.bottom - PB_VIEWPORT_PAD;
    const spaceAbove = triggerRect.top - PB_VIEWPORT_PAD;
    const naturalHeight = menu.scrollHeight;

    // Prefer opening downward whenever the content fits, or whenever
    // there's simply more room below than above. Otherwise flip up.
    let placement;
    let availableHeight;
    if (naturalHeight <= spaceBelow || spaceBelow >= spaceAbove) {
      placement = 'bottom';
      availableHeight = spaceBelow;
    } else {
      placement = 'top';
      availableHeight = spaceAbove;
    }

    // Neither direction may have room for the FULL menu — clamp to
    // whatever's available (with a sane floor/ceiling) and let it scroll.
    // Math.floor (not round) so a fractional budget — e.g. 217.41px of
    // real space — never gets rounded UP into overflow; measured against
    // a live layout, rounding this any other way let the rendered box
    // finish a fraction of a pixel past the viewport edge.
    const maxHeight = Math.floor(Math.min(
      PB_MAX_MENU_HEIGHT,
      Math.max(PB_MIN_MENU_HEIGHT, availableHeight),
    ));
    menu.style.maxHeight = `${maxHeight}px`;

    // Horizontal: right-align to the trigger by default, then clamp so the
    // menu can never overflow the viewport on either side.
    const menuWidth = menu.offsetWidth;
    let left = triggerRect.right - menuWidth;
    left = Math.min(left, viewportW - menuWidth - PB_VIEWPORT_PAD);
    left = Math.max(left, PB_VIEWPORT_PAD);
    left = Math.floor(left);

    let top;
    if (placement === 'bottom') {
      top = triggerRect.bottom + PB_DROPDOWN_GAP;
    } else {
      const renderedHeight = Math.min(naturalHeight, maxHeight);
      top = triggerRect.top - PB_DROPDOWN_GAP - renderedHeight;
    }
    // Final safety clamp — belt-and-braces in case of extreme viewports.
    top = Math.max(PB_VIEWPORT_PAD, Math.min(top, viewportH - PB_VIEWPORT_PAD));
    top = Math.floor(top);

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.dataset.pbPlacement = placement;
  }

  function handleReposition() {
    if (isOpen) place();
  }

  function handleOutsideClick(e) {
    if (menu.contains(e.target) || trigger.contains(e.target)) return;
    close();
  }

  function handleKeydown(e) {
    if (e.key === 'Escape') close();
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    place();
    menu.classList.add('pb-menu-open');

    // Scoped, temporary listeners — attached only while the menu is open.
    window.addEventListener('resize', handleReposition);
    // capture:true because 'scroll' doesn't bubble; this is the only way
    // to notice an inner scrollable ancestor (not just the window) moving.
    document.addEventListener('scroll', handleReposition, true);
    // bubble phase is enough for outside-click detection, and is the
    // least invasive option — it never stops the host page's own handling.
    document.addEventListener('click', handleOutsideClick);
    document.addEventListener('keydown', handleKeydown);
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    menu.classList.remove('pb-menu-open');
    window.removeEventListener('resize', handleReposition);
    document.removeEventListener('scroll', handleReposition, true);
    document.removeEventListener('click', handleOutsideClick);
    document.removeEventListener('keydown', handleKeydown);
  }

  function toggle() {
    if (isOpen) close();
    else open();
  }

  function destroy() {
    close();
    menu.remove();
  }

  // `{ open, close, toggle, ... }` is "property shorthand" — when the key
  // name and the variable name are identical, JS lets you skip writing
  // `open: open`. This is the same trick used all over this codebase
  // (e.g. `{ apiKey, promptStyle }` in service-worker.js).
  //
  // Note `isOpen: () => isOpen` specifically: the LEFT `isOpen` is the key
  // in the returned object; the RIGHT `isOpen` is the closured variable
  // from up above. We can't just write `isOpen` (shorthand) here, because
  // that would copy today's true/false value once and freeze it forever —
  // wrapping it in a tiny arrow function `() => isOpen` instead means
  // every call to `dropdown.isOpen()` re-reads the variable's CURRENT
  // value at the moment you call it.
  //
  // Whatever calls pbCreateDropdown(...) only ever gets to see these five
  // named functions — `isOpen` the raw variable, `place`, `handleReposition`,
  // `handleOutsideClick`, and `handleKeydown` all stay private to this
  // function. This "return an object of functions, keep the rest hidden"
  // shape is sometimes called the *revealing module pattern*.
  return { open, close, toggle, isOpen: () => isOpen, reposition: place, destroy };
}
