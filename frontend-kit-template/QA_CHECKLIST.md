# Frontend agent delivery and QA

1. Configure the exported HTTPS `/chat` endpoint and confirm the exact final website origin in `ALLOWED_ORIGINS.json` and Studio’s live CORS check.
2. Run the local demo with the exported kit. Confirm a genuine reply on the final site and inspect any request ID returned for a failure.
3. Register a local handler for each enabled action. Test valid and invalid enum values, a missing handler, and a handler returning false. Expose an accessible confirmation only when the handler reports success.
4. Test opening, closing and submitting entirely by keyboard. Confirm Escape returns focus to the launcher. Test at mobile width, at 200% zoom, and with reduced motion.
5. Configure the privacy notice and policy URL for this client. If using Turnstile, supply `getTurnstileToken` when mounting the widget, reset the verification between sends, and render the widget with action `falco_chat`.
6. Record the tested URL, browser, date and outcome in your delivery. Use the export’s API contract and preserve rollback access for the site integration.
