# Chatbot privacy notice template

Configure a short `privacy.notice` and an HTTPS `privacy.url` in `config/falco.config.js`, from Studio export, or as widget overrides. Example draft for adaptation:

> Your message and recent chat turns are sent to [business] and its AI provider to answer your question. Please avoid including sensitive information. See our privacy policy for details and contact information.

Before publishing, fill in the controller and contact, purpose and legal basis, AI provider and subprocessors, applicable data transfers, actual retention for each processor, and how people can exercise their rights. Check the service agreements and DPA for your Cloudflare and AI provider plans. Have the applicable jurisdiction and site owner review the notice.

Falco's reference frontend keeps recent turns in memory and does not write them to browser storage. The selected AI provider may process messages, recent turns and the configured business context under its own settings. Confirm actual provider retention before making a retention statement. If Turnstile is enabled, include its collection in the site’s disclosure.
