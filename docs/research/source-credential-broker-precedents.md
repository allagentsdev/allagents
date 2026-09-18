# Source credential broker precedents

## Decision

The execution gateway does **not** need a mandatory standalone Git credential
broker for trusted local use. The settled local provider is an explicit,
account-pinned `gh auth token --hostname <host> --user <account>` helper invoked
only when no App installation mapping applies. Its environment removes
`GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, and
`GITHUB_ENTERPRISE_TOKEN`, and its token is exposed only to the one-shot
acquisition process. Git credential helpers and Git Credential Manager (GCM)
establish the process-boundary precedent, but arbitrary configured helpers are
not part of the selected implementation. A local helper is a broker in the
security sense; it is not a separately deployed network service.

Remote or multi-tenant workers use one initial path: an authoritative
gateway/control-plane lease controller and trusted central token minter deliver
a fresh GitHub token over an authenticated, single-use, non-durable lease. The
GitHub bearer token is scoped only to the repository, read-only contents
permission, and GitHub expiry. Worker identity, attempt, lease epoch, command
revision, fence, operation, and delivery expiry are properties of the lease and
channel, not the token. Workers never inherit a person's credential helper,
credential store, SSH agent, or the App private key. A versioned central
snapshot-delivery protocol is deferred; it is not an alternative initial
readiness path. The minter may live inside the trusted control plane unless
private-key isolation, audit, scaling, or blast-radius requirements justify a
separate service process.

## Precedents

### Git credential helpers and Git Credential Manager

**Trust boundary.** Git credential helpers are external programs. Git invokes a
configured helper through the shell, supplies an operation and credential context,
and stops consulting helpers after it has a username and a non-expired password
([Git `gitcredentials`](https://git-scm.com/docs/gitcredentials#Documentation/gitcredentials.txt-helper)).
The scriptable `git credential fill` interface sends the repository context on
standard input and returns the resolved username and password on standard output
([Git `git-credential`](https://git-scm.com/docs/git-credential#_typical_use_of_git_credential)).
Consequently, the Git/acquisition process receives the resulting bearer secret;
the helper is not a membrane that makes an untrusted caller safe.

GCM is an implementation of this local contract, not a required remote service.
Its executable is a console application; on every invocation it reads Git's
request from standard input, retrieves or generates a credential, serializes the
credential to standard output, and terminates
([GCM architecture, “Command execution”](https://github.com/git-ecosystem/git-credential-manager/blob/main/docs/architecture.md#command-execution)).
Git calls it implicitly, and later Git commands reuse stored credentials or tokens
while they remain valid
([GCM README, “How to use”](https://github.com/git-ecosystem/git-credential-manager#how-to-use)).
GCM can put credentials in OS-controlled stores such as Windows Credential
Manager or macOS Keychain, use Secret Service or GPG-backed storage, use Git's
ephemeral cache, or disable its store entirely
([GCM credential stores](https://github.com/git-ecosystem/git-credential-manager/blob/main/docs/credstores.md)).

**Lifetime.** Helper-process lifetime and credential lifetime are separate. GCM
exits after each request, while the selected store controls token persistence.
Git's built-in cache is an optional local daemon reachable over a Unix-domain
socket restricted to the current user; it forgets credentials after 900 seconds
by default or sooner if the daemon dies
([Git `git-credential-cache`](https://git-scm.com/docs/git-credential-cache#_description),
[options](https://git-scm.com/docs/git-credential-cache#_options)). This is a
local process/socket boundary, not a remotely reachable credential service.

**Relevance.** Git helpers and GCM prove that a local credential provider can
be an on-demand process rather than a network service. AllAgents does not,
however, inherit or invoke an arbitrary configured helper chain. Its closed
provider registry permits only an explicit GitHub CLI provider pinned to a
configured non-secret account in a trusted-local profile, and only when no
configured GitHub App installation mapping applies. The helper invokes
`gh auth token --hostname <host> --user <account>` without ambient GitHub token
variables. Its output reaches only the one-shot acquisition child; setup and
the coding harness inherit neither helper configuration nor the token.

### SSH agent forwarding

**Trust boundary.** `ssh-agent` holds private keys and exposes operations through
a Unix-domain socket. With forwarding, private keys and passphrases do not cross
the network; the SSH connection carries requests to the local agent and returns
the results
([OpenSSH `ssh-agent`](https://man.openbsd.org/ssh-agent#DESCRIPTION)). The
forwarded socket is nevertheless an authentication capability. OpenSSH warns
that anyone able to bypass the remote socket's permissions can use loaded
identities to authenticate even though they cannot extract the key material
([OpenSSH `ForwardAgent`](https://man.openbsd.org/ssh_config#ForwardAgent)).
GitHub gives the same operational warning: a trusted server can use the keys as
the user while the connection is established, so forwarding should be enabled
only for specifically trusted hosts
([GitHub, “Using SSH agent forwarding”](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/using-ssh-agent-forwarding#setting-up-ssh-agent-forwarding)).

**Lifetime.** The remote forwarding capability lasts for the SSH connection.
The underlying identity may live longer: `ssh-agent` has no default maximum
identity lifetime unless configured, while `ssh-add -t` can impose one and
`ssh-add -c` can require confirmation for each use
([OpenSSH `ssh-agent -t`](https://man.openbsd.org/ssh-agent#t),
[OpenSSH `ssh-add`](https://man.openbsd.org/ssh-add#c)).

**Relevance.** Agent forwarding is precedent for reusing a local identity
without copying the long-lived private key, but it is not selected for
AllAgents direct Git acquisition, which accepts canonical HTTPS repository URLs
only. A remote process with the forwarded socket could authenticate as the
user, so the socket must never reach a remote worker, setup code, or the
coding-agent runtime.

### GitHub App installation tokens and Actions checkout

**Trust boundary.** A GitHub App uses an RS256 JWT, created with the App private
key, to request an installation access token
([GitHub, “Generating a JSON Web Token”](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)).
The mint request can narrow the token to selected repositories and permissions,
and GitHub will not grant repositories or permissions beyond those already
granted to the installation
([GitHub, “Generating an installation access token”](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app#generating-an-installation-access-token)).
This separates high-value issuer material from the disposable credential handed
to a worker.

GitHub Actions applies that model per job. GitHub creates a unique
`GITHUB_TOKEN` before each job; it is a GitHub App installation token limited to
the workflow repository, with permissions reducible through workflow policy
([GitHub Actions `GITHUB_TOKEN`](https://docs.github.com/en/actions/concepts/security/github_token#about-the-github_token)).
`actions/checkout` uses the token for Git commands, stores persisted credentials
in a separate file under `RUNNER_TEMP`, references that file from Git config, and
removes the references and file during post-job cleanup
([checkout README, v6 credential storage](https://github.com/actions/checkout#checkout-v6),
[checkout credential setup](https://github.com/actions/checkout/blob/main/src/git-auth-helper.ts#L329-L436),
[checkout credential cleanup](https://github.com/actions/checkout/blob/main/src/git-auth-helper.ts#L475-L510)).

**Lifetime.** A normal GitHub App installation token expires after one hour
([GitHub installation token documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app#generating-an-installation-access-token)).
The Actions token expires when its job finishes or at its effective maximum
lifetime; GitHub documents a six-hour maximum on GitHub-hosted runners and at
most 24 hours of refresh for longer self-hosted jobs
([GitHub Actions `GITHUB_TOKEN`](https://docs.github.com/en/actions/concepts/security/github_token#about-the-github_token)).
Checkout's credential file is a convenience capability inside that job, not a
long-term credential store, and its post-job deletion is defense in depth rather
than the token's revocation mechanism.

**Relevance.** This is the closest production precedent for AllAgents: keep the
App private key at a trusted central minter, issue one fresh least-privilege
token for a particular repository acquisition, expose it only during that
phase, and remove its local material afterward. GitHub enforces repository,
read-only contents permission, and expiry; AllAgents separately enforces
attempt and operation bindings through its authenticated delivery lease.

### BuildKit secret and SSH mounts

**Trust boundary.** BuildKit distinguishes secret delivery from ordinary build
arguments and environment variables, which can persist in an image. A secret
mount makes a client-provided secret temporarily available only to a particular
build instruction; an SSH mount supplies an agent socket or key and is intended
for cases such as fetching private Git repositories
([Docker build secrets](https://docs.docker.com/build/building/secrets/#types-of-build-secrets)).
`RUN --mount=type=secret` makes the value available without baking it into the
image, while `RUN --mount=type=ssh` exposes SSH-agent access through a mounted
socket
([Dockerfile secret mount](https://docs.docker.com/reference/dockerfile/#run---mounttypesecret),
[Dockerfile SSH mount](https://docs.docker.com/reference/dockerfile/#run---mounttypessh)).

The isolation guarantee is intentionally narrow. BuildKit states that secret
values must not be written to disk or included in cache checksums and that an
untrusted frontend cannot access forwarded SSH private keys; it also states that
a container explicitly run with a secret mount can read that secret
([BuildKit security boundary](https://github.com/moby/buildkit/blob/master/PROJECT.md#security-boundary)).
A mount therefore limits *where and when* a capability appears; it does not make
code within the mounted step trustworthy.

**Lifetime.** The secret mount is available for the duration of its build
instruction, rather than becoming part of the resulting image
([Docker build secrets](https://docs.docker.com/build/building/secrets/#secret-mounts)).
When an agent socket is supplied, SSH access is available for the mounted
instruction without adding the private key to the image
([Dockerfile SSH mount](https://docs.docker.com/reference/dockerfile/#run---mounttypessh)).

**Relevance.** AllAgents should copy the phase-scoping pattern, not necessarily
BuildKit itself: inject a token or agent capability only into the trusted source
acquisition operation, then tear down the mount/socket/environment before setup
or agent execution. Like BuildKit, this delivery mechanism does not mint
credentials and does not eliminate the need for a central issuer in production.

## Recommendation for AllAgents

### Local mode

1. Resolve `github.com` through the built-in GitHub backend and require explicit
   host/API mappings for GitHub Enterprise Server hostnames.
2. Prefer a configured GitHub App installation that trusted operator policy
   maps to the authorized repository. Do not use `@octokit/auth-app` to discover
   installations. If no installation mapping applies, a trusted-local profile
   may invoke the explicit
   `gh auth token --hostname <host> --user <account>` provider pinned to a
   configured non-secret account. Include that account in the entitlement and
   effective-profile digests, remove `GH_TOKEN`, `GITHUB_TOKEN`,
   `GH_ENTERPRISE_TOKEN`, and `GITHUB_ENTERPRISE_TOKEN` from the helper
   environment, and fail if the configured account cannot be resolved. Do not
   inherit an arbitrary Git helper/GCM chain or forward an SSH agent.
3. Treat provider order as eligibility, not retry. Once the App provider is
   selected, configuration, authentication, minting, authorization, rate-limit,
   or service failure terminates acquisition without falling through to the
   user identity.
4. Give the resolved token only to the dedicated acquisition subprocess through
   a temporary helper channel, remove that channel, terminate the child, and
   publish only a credential-free verified workspace before setup or the coding
   harness starts.
5. Do **not** require or auto-start an AllAgents network credential service for
   trusted local execution. The explicit account-pinned provider subprocess is
   sufficient.

### Production remote or multi-tenant workers

1. Put GitHub App issuer material in a trusted central token-minter component.
   Trusted operator configuration, not auth-app discovery, maps the repository
   to an installation ID. For every cache-miss acquisition, use focused
   [`@octokit/auth-app`](https://github.com/octokit/auth-app.js) with
   `refresh: true` to bypass its installation-token cache and mint a fresh token
   narrowed to that repository and read-only contents permission. Require
   remaining lifetime strictly greater than the acquisition deadline plus
   clock-skew margin, expire the delivery lease no later than the token, and
   fail readiness when the configured acquisition ceiling can exceed a fresh
   token's safe lifetime.
2. Make the gateway/control-plane credential-lease controller authoritative.
   The authenticated worker requests only by active attempt and fence. From
   durable dispatch and policy state, the controller derives the
   effective-profile digest, selected provider, host/API-mapping digest,
   installation ID, repository, operation, worker route and identity, lease
   epoch, command revision, and expiry. Immediately before issuance it rechecks
   active command revision, tombstone, fence, and lease state.
3. Deliver one single-use, non-durable grant/response over the authenticated
   acquisition channel. A separate minter must agree with the controller's
   configuration digest and consume the grant atomically. Reject replay,
   substituted fields or providers, stale command state, and configuration
   disagreement. The bearer token itself remains scoped only by GitHub to the
   repository, read-only contents permission, and expiry; worker, attempt,
   fence, and operation bindings belong to the lease.
4. Advance a GitHub App entitlement generation from authenticated lifecycle
   webhooks plus bounded reconciliation whenever an installation is uninstalled,
   suspended, or changes repository selection. Unknown or stale installation
   state fails cache authorization. Mint only on a cache miss. On a miss, record
   the acquiring provider in operator provenance; on a hit, record `cache_hit`,
   the cached original acquisition-provider metadata, and current policy
   selection/entitlement binding separately.
5. Publish deterministic coarse failures: `source_auth_unavailable` /
   `no_eligible_provider` (not retryable); `source_auth_denied` /
   `installation_repository_denied` (not retryable);
   `source_auth_failed` with `app_configuration_invalid`,
   `app_authentication_failed`, or `app_mint_failed` (not retryable),
   `provider_rate_limited` or `provider_unavailable` (retryable), or
   `trusted_local_cli_failed` (not retryable). Keep provider, installation, and
   account identifiers in operator-only provenance.
6. Never forward an operator's general SSH agent or reuse their desktop GCM
   store in a remote worker. Those capabilities represent the person, not the
   individual execution request.
7. Keep minting logically central even if it initially lives inside the trusted
   gateway process. Split the minter into a standalone network service when
   remote trust boundaries, private-key isolation, audit, scaling, or
   blast-radius controls require it. A versioned central snapshot-delivery
   protocol may be designed later, but is not part of the initial architecture.

The resulting rule is: **local reuse may be subprocess-mediated; production
issuance must be centrally policy-mediated.** A process boundary is required in
both cases, but a standalone credential service is not.
