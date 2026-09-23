-- Proton Authenticator helper for the Omarchy panel plugin
-- (package: proton-authenticator-omarchy-helper).
--
-- Proton's windows open floating and centered, like Omarchy's other password
-- managers, and are hidden from screen sharing because they show 2FA secrets.
-- The sign-in window ("Log in" / "Sign up") gets a taller card that fits
-- Proton's hosted sign-in page without scrolling.
o.window("^proton-authenticator-omarchy-helper$", {
  float = true,
  center = true,
  size = { 875, 600 },
  no_screen_share = true,
})

o.window({ class = "^proton-authenticator-omarchy-helper$", title = "^(Log in|Sign up)$" }, {
  size = { 560, 760 },
})
