# ECS Controller Bootstrap and Verification

Target: public Ubuntu ECS replacing the Wuying Linux cloud computer as the production control plane.

Scope note (2026-09-16): Phase 1 is the limited invited internal pilot; Phase 2 is production launch. The controller is already deployed and the user reported a completed HTTP toolchain smoke. Commands below are infrastructure reference checks, not a claim that deployment has not started. The account/protocol-2 code is locally verified but not yet deployed; see [phase1-implementation.md](phase1-implementation.md).

Recommended pilot size: Ubuntu 22.04 LTS x86_64, 4 vCPU, 16 GiB RAM, ESSD PL1 100 GiB, public IPv4 or EIP, 5-10 Mbps. Open security-group ingress only for TCP 443 and administrator-restricted TCP 22. Do not expose PostgreSQL or Redis.

Run the following blocks on the ECS as a sudo-capable user. Return the requested output for each item; redact passwords, access keys, private keys and tokens.

## E1. System identity and resources

```bash
hostnamectl
cat /etc/os-release
uname -a
printf 'vCPU='; nproc
free -h
df -hT /
ip -br addr
```

Return: hostname, Ubuntu version, kernel, vCPU count, total/available memory, root filesystem size/free space, and interface/IP lines.

## E2. Base tools and time

```bash
for c in ca-certificates curl git openssl jq unzip tar; do
  printf '%-18s' "$c"
  dpkg-query -W -f='${Status} ${Version}\n' "$c" 2>/dev/null || true
done
timedatectl status | sed -n '1,12p'
```

Return: one line per package and the `System clock synchronized`/`NTP service` lines.

## E3. Node.js runtime

```bash
node --version
npm --version
which node npm
```

Return all four lines. Node.js 20+ is required; Node 24 is acceptable if it is the chosen deployment runtime.

## E4. Container runtime

```bash
docker --version
docker compose version
sudo systemctl is-enabled docker || true
sudo systemctl is-active docker || true
sudo docker run --rm hello-world
```

Return versions and service states if using Compose. Docker/registry access is not a prerequisite for the Phase 1 systemd deployment; verify it before choosing the container path.

## E5. PostgreSQL and Redis

```bash
sudo systemctl is-active postgresql || true
psql --version
sudo ss -lntp | grep -E ':(5432|6379)\b' || true
sudo systemctl is-active redis-server || true
redis-cli ping
```

Return service states, versions and listener addresses. PostgreSQL is required in Phase 1; Redis is optional because PostgreSQL owns the queue/locks. If Redis is used, confirm `PONG`. Neither database may listen publicly.

## E6. Nginx and public listeners

```bash
nginx -v
sudo systemctl is-enabled nginx || true
sudo systemctl is-active nginx || true
sudo ss -lntp
curl -sS -I --max-time 10 http://127.0.0.1
```

Return Nginx version/state, all listening sockets and the local HTTP status. The final deployment requires TCP 443; port 80 may remain only for ACME redirect/challenge.

## E7. Firewall and public address

```bash
sudo ufw status verbose || true
sudo iptables -S INPUT
curl -4sS --max-time 10 https://api.ipify.org; echo
```

Return UFW status, INPUT policy/rules and the ECS public IPv4. Verify security-group rules in the Alibaba Cloud console separately: inbound 443 from the intended users, inbound 22 from the administrator IP only, and no 5432/6379.

## E8. Outbound HTTPS and DNS

```bash
getent hosts www.alibabacloud.com
curl -sS -I --max-time 15 https://www.alibabacloud.com
curl -sS -I --max-time 15 https://registry-1.docker.io/v2/
```

Return DNS resolution and HTTP status/headers for the services actually used. Phase 1 workers require outbound controller/tool access. ECS access to Wuying OpenAPI and OSS becomes required for Phase 2; container registry access applies only to container deployments.

## E9. Deployment directories and permissions

```bash
sudo install -d -m 0750 /opt/yahahagame-controller/{controller,app,config,logs}
sudo install -d -m 0750 /var/lib/yahahagame-controller
stat -c '%U:%G %a %n' /opt/yahahagame-controller /var/lib/yahahagame-controller
```

Return the two `stat` lines. Apply the source/service/artifact ownership separation in `controller/DEPLOYMENT.md`; do not recursively transfer the deployed source/config tree to the interactive user. Secrets belong under the protected config directory.

## E10. Required external checks before application deployment

In the Alibaba Cloud console, return screenshots or text for:

- ECS instance ID and region/zone;
- VPC and vSwitch IDs;
- public IPv4/EIP association;
- security-group inbound and outbound rules;
- RAM role attached to the ECS, if used;
- DNS record and certificate status for the controller domain.

Do not send credentials. Phase 1 uses outbound worker polling and artifact-transfer verification. WSS/mTLS, RAM-role provider operations and OSS checks are Phase 2 work; trusted browser HTTPS is required for the Phase 1 account release.

## Current environment record

The first ECS bootstrap check completed with the following results:

```text
Instance: i-uf6fhgeo7hiejpiko1a8
Region/AZ: cn-shanghai / cn-shanghai-b
VPC: vpc-uf6qdzehtr0sejgm64f36
vSwitch: vsw-uf6cponndt1jgaimzjaid
Private IP: 172.16.2.155
EIP: 139.224.32.61
OS: Ubuntu 22.04.5 LTS
Capacity: 4 vCPU / approximately 15 GiB RAM / approximately 99 GiB root disk
Node.js: v24.21.0
Docker: 29.1.3 / Compose 2.40.3
PostgreSQL: 14.24, private listener
Redis: running, private listener, PONG
Nginx: 1.18.0, HTTP 80 active
```

Docker Hub access currently requires the configured local SOCKS5 proxy. Any future systemd service that needs external access must receive an explicit proxy configuration or use an approved reachable registry; do not assume an interactive shell proxy is inherited by services.

The historical environment record above is retained. Current rollout items are:

1. Confirm Alibaba Cloud security-group ingress/egress in the console. Allow TCP 443 from intended clients and TCP 22 only from fixed administrator IPs. Do not allow public 5432 or 6379.
2. Phase 2: prepare least-privilege RAM-role access for Wuying and OSS. This is not a blocker for the manually prepared Phase 1 workers.
3. Phase 1 accounts: establish trusted HTTPS ingress and set `PUBLIC_ORIGIN`. The later Phase 2 Worker endpoint is `wss://<domain>/v1/worker/connect`.
4. Upgrade the existing controller/app and worker together after draining old jobs, applying versioned migrations and issuing per-worker credentials. Preserve existing database/artifacts and explicitly classify legacy task ownership.
5. From an external network, verify TCP 443 and HTTPS. A local request to the EIP is not sufficient because public loopback may be restricted.
6. Phase 1: verify session/task isolation, protocol-2 polling, continuous heartbeat, effective cancellation, artifact access and real-project output. Reserve WSS/cross-worker/cloud-lifecycle verification for Phase 2.
