// Text for whatever was thrown: an Error, a string, or nothing at all. Every
// catch that shows or records an error goes through here, so a null or
// undefined throw can't crash the handler itself.

/** @param {any} e */
export const errorMessage = (e) => `${e?.message ?? e}`;

// An error's first line, for a notification.
/** @param {any} e */
export const errorText = (e) =>
  errorMessage(e).trim().split("\n")[0] || "Something went wrong";
