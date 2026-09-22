# Source credential broker precedents

## Decision

The initial trusted-network deployment uses deployment-supplied source
credentials referenced from the project `workspace.yaml` as `${ENV_VAR}` values.
The AllAgents materializer receives only the configured credential variables in
its allowlisted child environment. HarnessRouter removes every
materializer-only variable from agent child environments regardless of its name.

Git credentials are exposed only to the acquisition process through a
short-lived, materializer-owned credential helper or registry-auth channel.
The materializer uses hermetic Git and registry configuration, removes temporary
auth state before returning, and emits no secret in logs, provenance, checkpoints,
or response metadata. It never consults arbitrary ambient credential helpers and
never falls through to a different credential identity after a failure.

Git credential helpers, GitHub App installation tokens, and BuildKit secret
mounts establish the process- and phase-boundary precedents. The deployment does
not require a standalone network credential broker. Central token minting,
delivery leases, remote workers, and multi-tenant credential policy require a
separate decision if the deployment boundary changes.

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

**Relevance.** Git helpers and GCM prove that a local credential provider can be
an on-demand process rather than a network service. The AllAgents materializer
does not inherit or invoke the host's configured helper chain. It creates a
closed helper for the selected deployment credential, invokes Git with an
isolated home and system/global configuration disabled, and removes the helper
before returning. The coding-agent runtime inherits neither the helper
configuration nor its credential.

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

**Relevance.** GitHub App installation tokens are useful deployment inputs
because repository scope, read-only contents permission, and expiry are enforced
by GitHub. Token minting remains outside the materializer contract. If an
operator supplies such a token through the configured environment reference,
the materializer still treats it as a phase-scoped acquisition secret and binds
the resulting source identity to the session's effective descriptor digest.

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

**Relevance.** AllAgents uses the same phase-scoping pattern: inject a token only
into the trusted source-acquisition operation, then remove the
mount/socket/environment before agent execution. Like BuildKit, this delivery
mechanism does not mint credentials and does not make code with access to the
secret trustworthy.

## Recommendation for AllAgents

### Initial trusted-network deployment

1. Store only `${ENV_VAR}` references in the project workspace configuration;
   reject literal credentials and caller-supplied credential identifiers.
2. Supply secret values through the deployment environment and validate required
   names during materializer preflight without contacting sources.
3. Pass only the referenced, allowlisted names to the materializer child. Remove
   the complete allowlist from every coding-agent child independent of
   secret-looking name patterns.
4. Select one configured credential identity before acquisition. Authentication,
   authorization, rate-limit, or service failure terminates acquisition and
   never falls through to another identity or source mode.
5. Give the credential only to the dedicated acquisition subprocess through a
   temporary helper or registry-auth channel. Invoke helpers directly without a
   shell and bound their input, output, stderr, and lifetime.
6. Use isolated Git/registry configuration. Prevent credentials from entering
   remote URLs, Git config, generated CLI config, workspace files, nested
   repositories, checkpoints, logs, provenance, or response metadata.
7. Remove helper files, auth configuration, and the credential-bearing process
   before returning the validated staging tree to HarnessRouter.
8. Verify containment with a deliberately non-secret-looking environment name,
   because name-based secret filters are not the security boundary.

### Remote or multi-tenant deployment

A future deployment may require a central token minter, authenticated single-use
delivery leases, entitlement generations, revocation reconciliation, worker
identity, fencing, and a snapshot-delivery protocol. Those mechanisms require a
separate decision when remote workers or tenant isolation become product
requirements.

The resulting rule is: **source credentials exist only during the materializer's
acquisition phase and never enter the coding-agent environment.**
