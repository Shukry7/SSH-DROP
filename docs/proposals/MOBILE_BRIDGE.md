# Mobile Bridge proposal

> Original exploratory proposal supplied by the project owner. This feature is not implemented. Technical and security decisions require review before development.

Yes, this is absolutely possible, and I think it's an excellent future feature for SSHDrop. You can build it without a mobile application, cloud server, or AI model.

I'd call it SSHDrop Mobile Bridge.

The idea is simple: Your desktop SSHDrop application is already connected to a remote Linux server. You temporarily allow your phone to access that connection through a mobile browser, using a one-time pairing code and a session time limit.

This would make SSHDrop useful even when you're away from your desk but still connected to the same local network.

## 1. How I imagine the feature working

SSHDrop — Mobile Bridge

Concept

Allow mobile access

Devices on your local network

Session duration

1 hour

2 hours

4 hours

8 hours

Example local address

[https://192.168.1.10:8443](https://192.168.1.10:8443?utm_source=chatgpt.com)

Example one-time pairing code

# 482 916 37

Expires after 2 minutes or first successful use

Mobile access duration

2 hours

Explore this configuration&#x20;

The address and code above are illustrative, not a live connection. A real application must generate a fresh random pairing code and configure trusted HTTPS.

### The complete user journey

1. Open SSHDrop on your desktop, already connected to your Linux server.
2. Go to Mobile Bridge → Enable mobile access.
3. Choose a session duration: 1, 2, 4, or 8 hours.
4. SSHDrop starts a temporary local web service and generates a one-time pairing code.
5. On your phone, connect to the same Wi-Fi network and visit the displayed HTTPS address, or scan its QR code.
6. Enter the pairing code. For additional security, SSHDrop can ask you to approve the phone on the desktop.
7. Your phone now has a touch-friendly terminal and remote file explorer.
8. Once the selected duration expires, the mobile session automatically disconnects.

The desktop's SSH connection can remain active after mobile access expires.

## 2. How the connection works technically

The phone does not connect directly to your remote Linux server.

Instead, your desktop SSHDrop application acts as a secure gateway between the phone and the existing SSH connection.

The phone accesses the selected remote server through SSHDrop running on your computer.

For example, you could be in your living room with your phone while SSHDrop is running on your desktop in another room.

From your mobile browser, you could run:

```
docker ps
docker logs --tail 50 my-app
cd /var/www/myapp
ls -lah
nano .env
```

The commands execute on the remote Linux server, not on your phone or desktop operating system.

For the safest design, the mobile browser should open its own SSH shell channel through the desktop connection, rather than sending keystrokes into whatever program is currently running in the desktop terminal.

## 3. What should the mobile interface contain?

I wouldn't simply shrink the desktop interface to a phone screen.

I'd design a proper mobile companion interface.

Production Server

Connected via SSHDrop Desktop

Active

TerminalFilesSession

deploy\@server:\~$ pwd

/home/deploy

deploy\@server:\~$ ls

app backups uploads

deploy\@server:\~$ \_

CTRL

ESC

TAB

↑

↓

←

→

Interactive navigation mockup — these panels demonstrate the proposed mobile layout, not a live SSH session.

I would include a mobile terminal with extra keys, a touch-friendly remote file explorer, file previews, and the ability to upload photos or documents directly from the phone to the connected server.

Mobile file editing could come later.

## 4. Security is the most important part

This feature gives a mobile browser the ability to run commands on a server. If the desktop SSH connection uses a privileged account, an unauthorized mobile user could gain those same privileges.

Your one-time code and session duration are good ideas, but they need additional protection.

| Security feature    | Recommended implementation                        |
| ------------------- | ------------------------------------------------- |
| One-time code       | Cryptographically random, single-use pairing code |
| Pairing validity    | 2 minutes                                         |
| Wrong attempts      | Rate-limit and invalidate after repeated failures |
| Desktop approval    | Require explicit approval of the connecting phone |
| Session duration    | 1, 2, 4 or 8 hours, enforced by the desktop       |
| Inactivity timeout  | 15 minutes by default                             |
| Device limit        | One authorized mobile device initially            |
| Session storage     | Random session identifier, protected cookie       |
| Connection security | Trusted HTTPS and secure WebSockets               |
| Server access       | Only explicitly selected SSH connections          |
| Emergency stop      | Revoke all mobile access instantly                |

A particularly important distinction:

The one-time pairing code is not the same thing as the session credential.

The pairing code expires after being used. The application then issues a separate, securely managed browser session that lasts for the selected time.

Even if the user chooses 2 hours, the original pairing code should not remain reusable for 2 hours.

OWASP recommends server-side session expiration, WebSocket origin validation, and explicit handling of long-lived connections.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://cheatsheetseries.owasp.org&sz=32)

OWASP Cheat Sheet Series+1

### One technical challenge: HTTPS on a local IP address

A URL such as `https://192.168.1.10:8443` is possible, but the desktop must actually provide TLS with a certificate trusted by the mobile browser.

Generating a self-signed certificate by itself will normally produce a browser warning. Simply using HTTP on the same Wi-Fi is not secure enough for transmitting terminal commands and authentication codes.

For the first production-quality version, you'd need a practical solution such as trusted local certificate provisioning or a domain you control with valid HTTPS certificates and local routing. An optional later integration with [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve?utm_source=chatgpt.com) could simplify private HTTPS access, although that requires the devices to join a tailnet.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://developer.mozilla.org&sz=32)

MDN+1

Also, being on the same Wi-Fi should never count as proof that a device is authorized.

## 5. Technology required

You can extend your planned desktop architecture rather than creating an entirely separate backend.

| Component          | Technology                    |
| ------------------ | ----------------------------- |
| Desktop            | Electron + React + TypeScript |
| Local gateway      | Node.js HTTPS server          |
| Browser API        | Express or Fastify            |
| Real-time terminal | WebSocket over TLS (WSS)      |
| Terminal rendering | xterm.js                      |
| SSH connection     | ssh2                          |
| Remote files       | SFTP                          |
| Temporary sessions | In-memory session store       |
| Pairing code       | Node.js `crypto`              |
| QR code            | QR generation library         |
| Mobile UI          | Responsive React              |

`xterm.js` already supports browser terminals and provides an addon for connecting terminal data to WebSockets.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

GitHub

The local server should only start when Mobile Bridge is enabled, listen on the selected network interface, and stop accepting connections when the feature is disabled. It must not enable internet-facing access or router port forwarding automatically.

Some Wi-Fi networks also isolate connected devices, so the phone and desktop won't always be able to reach each other, even when they use the same Wi-Fi name.

## 6. One more feature I would add

Mobile access permission modes.

View Only

Browse remote directories, read files, and view terminal output without allowing terminal input or file modifications.

File Access

Browse, upload, download, and optionally edit files, but without access to an interactive SSH terminal.

Full Terminal Access

Run commands through a dedicated SSH shell and use the file manager. This requires explicit approval and carries the same risks as using the remote account directly.

I'd make View Only the default when first enabling the feature.

Once users choose Full Terminal Access, it should be clear that this grants powerful remote-server control.

## 7. When should you develop it?

I would put it in SSHDrop v1.2 or a later release, after the desktop application is stable.

| Release   | Focus                                                                   |
| --------- | ----------------------------------------------------------------------- |
| v0.1–v0.3 | SSH terminal, visual explorer, drag-and-drop file transfer, code editor |
| v1.0      | Stable desktop product                                                  |
| v1.1      | Better synchronization, profiles, shortcuts                             |
| v1.2      | Mobile Bridge: LAN access, pairing, session expiration, mobile terminal |
| v1.3      | Mobile file explorer, uploads/downloads, mobile file editing            |
| Later     | Optional private access across different networks                       |

For inspiration, look at [ttyd](https://github.com/tsl0922/ttyd?utm_source=chatgpt.com), an existing open-source project that makes terminal sessions available through a browser. Its WebSocket and browser-terminal approach is relevant, although SSHDrop would integrate this into its existing desktop connection and permission system.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

GitHub

## My recommendation

Definitely include Mobile Bridge in the long-term SSHDrop roadmap. It adds a practical reason to use SSHDrop instead of a standard terminal.

But I would keep its original promise simple:

> SSHDrop is your visual SSH workspace on desktop, with optional, temporary access from a mobile browser when you need it.

The most compelling experience would be enabling Mobile Bridge, scanning a QR code, entering a one-time code, approving the phone, and getting a useful remote terminal and file explorer—without installing an app on the phone or changing anything on the Linux server.

The main thing I would not compromise on is security. A convenient browser gateway to a production SSH connection deserves significantly more care than an ordinary file-transfer feature.
