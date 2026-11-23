# SocialP relay on Oracle Cloud (free)

Some networks (mobile data, phone hotspots, strict office/school Wi-Fi) block direct browser-to-browser connections. For those connections only, SocialP relays the end-to-end encrypted traffic through a TURN server. This sets one up on Oracle Cloud's **Always Free** tier: $0, with 10 TB of outbound traffic a month.

The relay can't read posts. It sees IP addresses and traffic volume of connections that use it.

## 1. Create the account
1. Sign up at <https://signup.cloud.oracle.com>. A card is asked for identity verification. Always Free resources are never charged unless you manually upgrade the account.
2. Pick a **home region** close to your users. It can't be changed later. If a region says it's out of capacity for free VMs, try another one.

## 2. Create the VM
1. Console → **Compute → Instances → Create instance**.
2. **Image**: Canonical Ubuntu 24.04. **Shape**: Ampere `VM.Standard.A1.Flex`, 1 OCPU, 6 GB RAM (Always Free eligible). If Ampere is unavailable, use `VM.Standard.E2.1.Micro`.
3. **Networking**: keep the default VCN and public subnet, with **Assign a public IPv4 address** checked.
4. **Add SSH keys**: download the generated private key (you only need it for debugging).
5. **Show advanced options → Management → Initialization script → Paste cloud-init script**: paste the contents of `cloud-init.yaml` with `__TURN_USER__` and `__TURN_PASS__` replaced (the app maintainer gives you a filled copy).
6. **Create**. Note the **Public IP address** once it's running.

## 3. Open the firewall (VCN security list)
Instance page → **Primary VNIC → Subnet → Security → Default Security List → Add Ingress Rules**. Add each of these with source `0.0.0.0/0`:

| Protocol | Destination port |
| --- | --- |
| UDP | 3478 |
| TCP | 3478 |
| TCP | 443 |
| TCP | 80 (only for the free TLS certificate) |
| UDP | 49152-65535 |

## 4. Check it
After about 5 minutes, SSH in (`ssh -i key ubuntu@<ip>`) and run `cat /opt/socialp-turn/READY`. It prints the relay URLs. Logs: `journalctl -u coturn`.

## 5. Connect the app
Set the repository secrets (Settings → Secrets and variables → Actions):

- `TURN_ICE`:
  ```json
  [{"urls":["turn:<ip>:3478?transport=udp","turn:<ip>:3478?transport=tcp","turns:<ip-with-dashes>.sslip.io:443?transport=tcp"],"username":"<user>","credential":"<pass>"}]
  ```
- `TURN_TRUSTED`: `1`. This is your own relay, so the app offers it on every connection, and browsers still pick a direct path whenever one works.

Then re-run the **Deploy to GitHub Pages** workflow.

## Limits and abuse
The login is shared by every app user, so it's visible to anyone who inspects the site. coturn is configured to:
- refuse relaying into private, loopback and cloud-metadata networks
- cap concurrent allocations (`total-quota`)
- cap per-session bandwidth (`max-bps`)

If the login leaks into heavy abuse, change the password in `/etc/turnserver.conf`, restart coturn and update `TURN_ICE`.
