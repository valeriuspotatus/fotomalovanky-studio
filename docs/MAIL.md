# Mail on the deployed studio

The Pošta tile works locally and not on Render. This is why, and what to do about it.

## Why it is off

Proton has no hosted IMAP. It speaks IMAP and SMTP only through **Proton Bridge**, a desktop
application that listens on `127.0.0.1:1143` on the machine it runs on. Render cannot reach a port
on your PC, so the deployed studio has nothing to connect to and `mail.enabled` is `false` there.

Turning the flag on does not fix it. There is genuinely nothing at that address from Render's side.

## What the code actually needs

Nothing Proton-specific. `src/proton/bridgeClient.js` is plain `imapflow` and `src/proton/smtpClient.js`
is plain `nodemailer`; Bridge is only the default host and port:

```js
createBridgeClient({ host = '127.0.0.1', port = 1143, user, pass, secure = false, ... })
createSmtpClient({ host = '127.0.0.1', port = 1025, user, pass, secure = false, ... })
```

All of those come from `config.mail`. The studio needs **a mailbox it can reach**, not Bridge.

## The setup

Customers keep writing to `info@fotomalovanky.cz` and it keeps arriving in Proton. A forwarding rule
copies each message into a hosted mailbox; the studio reads that one and replies through its SMTP.

1. **Create a mailbox** with a provider that offers plain IMAP and SMTP for a custom domain.
   Migadu (Swiss, about €19/year) and Fastmail both work. Note the IMAP host, the SMTP host, the
   username and the password.
2. **Forward Proton to it.** In Proton: Settings -> Filters -> forward `info@fotomalovanky.cz` to the
   new mailbox, and confirm the address when Proton asks.
3. **Add DNS records on `fotomalovanky.cz`** so replies sent from the dashboard are not treated as
   forgeries: the provider's SPF include, and its DKIM record. **Leave the MX records pointing at
   Proton** — mail still arrives there.
4. **Point the studio at it.** In the Render Secret File (`config.json`):

   ```json
   "mail": {
     "enabled": true,
     "host": "imap.yourprovider.com",
     "port": 993,
     "secure": true,
     "smtpPort": 465,
     "user": "studio@fotomalovanky.cz",
     "pass": "the mailbox password",
     "fromAddress": "info@fotomalovanky.cz"
   }
   ```

   `fromAddress` is what the customer sees; `user` is what authenticates. They differ on purpose.

## Two things to be deliberate about

**A plaintext copy of customer mail lives outside Proton.** Forwarding decrypts on the way out — it
has to, or the destination could not read it. That mail carries family names, addresses and
photographs of people's children, so the provider you choose becomes a data processor. Pick one
hosted somewhere you are content to name if a customer asks.

**Forwarding breaks SPF for the original sender.** Some forwarded messages may be marked as spam by
the receiving provider. Most handle it; it is worth watching for the first week.

## The simpler alternative

Move `info@fotomalovanky.cz` off Proton entirely — change its MX to the new provider. One mailbox
instead of two, no forwarding delay, no duplicate copy, no SPF side effects, and the studio reads the
real inbox rather than a shadow of it. The cost is that Proton stops being where business mail lives.

If Proton was chosen for encryption at rest of *customer* mail, forwarding already gives that up, and
the second mailbox is pure overhead.

## What the code enforces

Certificate verification is on for every host except loopback, and there is no setting to turn it
off. `rejectUnauthorized: false` is correct for Bridge — it mints its own certificate and the traffic
never leaves the machine — and unsafe anywhere else, because it makes the client accept any
certificate presented to it.

For the same reason `validateConfig` refuses `mail.secure: false` when `mail.host` is remote: that
would put the mailbox password on the wire in the clear. Use the provider's TLS ports (usually 993
for IMAP and 465 for SMTP).
