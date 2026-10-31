import { useId, useRef, type ReactNode } from 'react';

interface HelpContent {
  explanation: string;
  example?: string;
  guidance: string;
}

export const connectionHelp = {
  host: {
    explanation: 'The address of the server you want to connect to: an IP address or a hostname.',
    example: '203.0.113.10 or server.example.com',
    guidance:
      'Find it in your hosting provider’s server dashboard, or ask your administrator. Enter only the address, without https://, a username, a port, or a folder path. A private address such as 192.168.1.10 needs a reachable local network or VPN.',
  },
  username: {
    explanation: 'The Linux account you are allowed to use on that server.',
    example: 'deploy, ubuntu, or debian',
    guidance:
      'Use the account specified by your hosting provider or administrator. This may differ from your email, hosting dashboard login, or computer username. Do not assume the account is root.',
  },
  port: {
    explanation: 'The network port where the server accepts SSH connections.',
    example: '22 is the usual SSH port.',
    guidance:
      'Leave 22 unless your provider or administrator gives you another SSH port. Use the SSH port, rather than a website port such as 80 or 443.',
  },
  authentication: {
    explanation: 'How you prove that you can sign in as the selected server user.',
    guidance:
      'Choose Password if the server allows that account to sign in with a password. Choose Private key if your provider gave you a key file or you already configured SSH keys. The server must allow your chosen method; selecting it here does not enable it on the server.',
  },
  password: {
    explanation: 'The password for the Linux account entered in Username.',
    guidance:
      'Get it from your administrator or the server setup process. It is usually not your hosting website password. Some servers accept keys only. SSHDrop does not save this password and clears the field after each connection attempt.',
  },
  privateKey: {
    explanation:
      'A private key file on your computer that matches a public key authorized for this server user.',
    example: 'id_ed25519, id_rsa, or a provider-supplied .pem file',
    guidance:
      'Choose the private file, not the .pub public-key file. Keep it private and do not share it. Choosing a key here does not install its public key on the server; your provider or administrator must have authorized it first.',
  },
  passphrase: {
    explanation: 'The password that unlocks an encrypted private key file on your computer.',
    guidance:
      'This can be different from your server account password. Enter the passphrase chosen when the key was created. Leave it blank only if the key has no passphrase. SSHDrop does not save it.',
  },
  directory: {
    explanation: 'The remote folder the file explorer opens after you connect.',
    example: '/home/deploy or /var/www',
    guidance:
      'Use an existing absolute Linux path beginning with /. The default / is the top of the filesystem, not the root user account. You can only access folders your account permits. Terminal cd commands do not change this explorer path or the upload destination.',
  },
} satisfies Record<string, HelpContent>;

export function ConnectionField({
  id,
  label,
  help,
  children,
  className = '',
  labelInput = true,
}: {
  id: string;
  label: string;
  help: HelpContent;
  children: ReactNode;
  className?: string;
  labelInput?: boolean;
}) {
  const popoverId = useId();
  const trigger = useRef<HTMLButtonElement>(null);

  return (
    <div className={`connection-field ${className}`}>
      <div className="field-heading">
        {labelInput ? (
          <label htmlFor={id}>{label}</label>
        ) : (
          <span className="field-label">{label}</span>
        )}
        <button
          ref={trigger}
          type="button"
          className="field-help-button"
          aria-label={`Help with ${label}`}
          title={help.explanation}
          popoverTarget={popoverId}
        >
          ?
        </button>
        <div
          id={popoverId}
          popover="auto"
          className="field-help-popover"
          role="note"
          aria-label={`${label} help`}
          onToggle={(event) => {
            const panel = event.currentTarget;
            if (!panel.matches(':popover-open') || !trigger.current) return;
            const anchor = trigger.current.getBoundingClientRect();
            panel.style.left = `${Math.max(12, Math.min(anchor.right + 12, window.innerWidth - panel.offsetWidth - 12))}px`;
            panel.style.top = `${Math.max(12, Math.min(anchor.top - 8, window.innerHeight - panel.offsetHeight - 12))}px`;
          }}
        >
          <div className="help-popover-heading">
            <h4>{label}</h4>
            <button
              type="button"
              aria-label={`Close ${label} help`}
              popoverTarget={popoverId}
              popoverTargetAction="hide"
            >
              ×
            </button>
          </div>
          <p id={`${id}-help`}>{help.explanation}</p>
          {help.example && <p className="help-example">{help.example}</p>}
          <p>{help.guidance}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

export function ConnectionGuide() {
  return (
    <details className="connection-guide">
      <summary>New to SSH? Start here</summary>
      <div className="connection-guide-content">
        <p>
          SSH lets you securely sign in to another computer, usually a Linux server. You need access
          to an existing server; SSHDrop does not create one or create a login for you.
        </p>
        <ol>
          <li>
            Open your hosting provider’s server dashboard, or ask your administrator for the SSH
            address, username, port, and a password or private key.
          </li>
          <li>
            Make sure the server is running and reachable. Its firewall must allow your SSH
            connection. File browsing and transfers also need SFTP enabled on the server.
          </li>
          <li>
            Fill in the fields below. Click a <strong>?</strong> for an explanation, then choose{' '}
            <strong>Connect to server</strong>.
          </li>
          <li>
            On your first connection, compare the server fingerprint with one obtained from your
            provider or administrator through a trusted channel before choosing to trust it.
          </li>
        </ol>
        <p className="guide-example-label">Already have an SSH command? For example:</p>
        <code>ssh -p 2222 deploy@203.0.113.10</code>
        <p>
          This means Host <strong>203.0.113.10</strong>, Username <strong>deploy</strong>, and Port{' '}
          <strong>2222</strong>. These are example values; replace them with your own server
          details.
        </p>
        <p>
          Connection refused or timed out? Check the address, port, server status, and network
          access. Authentication failed? Check the username and whether the server expects a
          password or an authorized key.
        </p>
      </div>
    </details>
  );
}
