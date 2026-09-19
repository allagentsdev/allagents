# Source credential broker precedents

## Decision

The execution gateway does **not** need a standalone Git credential broker for
the initial trusted-network deployment. It supports two in-process trusted
providers for `github.com`: a configured GitHub App and a configured,
account-pinned `gh auth token --hostname github.com --user <account>` fallback.

The App is preferred whenever an App-authenticated repository-coverage check
proves an installation eligible. `gh` is considered only when the App is absent
or coverage is positively ineligible; unknown discovery, authentication,
permission, rate-limit, or service failures fail closed. Ambient `GH_TOKEN`,
`GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, and `GITHUB_ENTERPRISE_TOKEN` are removed
from the CLI helper environment.

Either token is exposed only to the one-shot acquisition process through an
invocation-scoped Git credential helper. The helper, token, and acquisition
process are gone before adapter preparation or provider execution. Git
credential helpers and Git Credential Manager establish the process-boundary
precedent, but arbitrary configured helpers are not part of the selected
implementation. A local helper is a broker in the security sense; it is not a
separately deployed network service.

Central token minters, authenticated delivery leases, remote workers, and
multi-tenant credential policy are deferred until ADR 0002's deployment
boundary is reconsidered.

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
provider registry permits only the selected GitHub App token or an explicit
GitHub CLI provider pinned to a configured non-secret account when App
eligibility is positively absent. The CLI invokes
`gh auth token --hostname github.com --user <account>` without ambient GitHub
token variables. Its output reaches only the one-shot acquisition child;
adapter preparation and the coding runtime inherit neither helper configuration
nor token.

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
App private key in the trusted gateway process, issue one fresh least-privilege
token for a particular repository acquisition, expose it only during that
phase, and remove its local material afterward. GitHub enforces repository,
read-only contents permission, and expiry; the gateway separately binds the
acquisition to the retained Task and effective configuration digest.

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

### Initial trusted-network gateway

1. Resolve only canonical `github.com` HTTPS origins in the initial delivery.
2. Determine App applicability through an App-authenticated GitHub API client,
   or verify an explicitly configured installation ID against the repository.
   Model the result as `eligible`, `ineligible`, or `unknown`.
3. For `eligible`, use focused
   [`@octokit/auth-app`](https://github.com/octokit/auth-app.js) authentication
   and mint a fresh token narrowed to the repository and read-only contents.
   Require remaining lifetime greater than the gateway's at-most-900-second
   acquisition sub-budget plus a 60-second clock-skew margin.
4. For a missing App or proven `ineligible`, a trusted local deployment may use
   the configured `gh auth token --hostname github.com --user <account>`
   provider. Include the account in the acquisition-policy digest and strip
   ambient token variables. An `unknown` App result never falls through.
5. Treat provider order as eligibility, not retry. Once App is selected,
   configuration, authentication, minting, authorization, repository coverage,
   rate-limit, or service failure terminates acquisition.
6. Give the resolved token only to the dedicated acquisition subprocess through
   a temporary helper channel. Remove the channel and terminate the process
   before atomically publishing the credential-free verified workspace.
7. Do not require or auto-start a network credential service. Keep App issuer
   material and GitHub/OCI auth stores inaccessible to the adapter process and
   model-invoked tools.

### Deferred remote or multi-tenant deployment

A future deployment may require a central token minter, authenticated single-use
delivery leases, entitlement generations, revocation reconciliation, worker
identity, fencing, and a snapshot-delivery protocol. Those mechanisms are not
part of the selected single-process architecture. They require a separate
decision when remote workers or tenant isolation become product requirements.

The resulting initial rule is: **credential reuse is acquisition-subprocess-
mediated and ends before provider execution.** Remote or multi-tenant issuance
policy remains deferred; a standalone credential service is not required now.
