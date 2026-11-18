<?php
declare(strict_types=1);

if (!defined('RRV_API')) {
    http_response_code(404);
    exit;
}

const RRV_PASSWORD_COST = 12;
const RRV_PASSWORD_MAX_BYTES = 72;
const RRV_PASSWORD_MIN_LENGTH = 12;
const RRV_AUTH_LIFETIME = 28800;
const RRV_AUTH_IDLE = 3600;
const RRV_INVITE_LIFETIME = 604800;
const RRV_ATTEMPT_WINDOW = 900;
// Valid bcrypt hash used to keep failed login costs comparable for unknown accounts.
const RRV_DUMMY_PASSWORD_HASH = '$2y$12$p26IWb9vrbSGznpDNjfWTuHVYcd706xPSswGL.dxu/JxQptxSvN0C';

function auth_schema(PDO $db): void
{
    $db->exec(<<<'SQL'
        CREATE TABLE IF NOT EXISTS auth_accounts (
            id INTEGER PRIMARY KEY,
            role TEXT NOT NULL CHECK (role IN ('owner', 'client')),
            email TEXT NOT NULL COLLATE NOCASE,
            client_id INTEGER UNIQUE REFERENCES clients(id) ON DELETE CASCADE,
            status TEXT NOT NULL CHECK (status IN ('invited', 'active', 'revoked')),
            password_hash TEXT,
            invitation_hash TEXT UNIQUE,
            invitation_expires_at INTEGER,
            session_version INTEGER NOT NULL DEFAULT 1,
            CHECK (
                (role = 'owner' AND client_id IS NULL AND status = 'active')
                OR (role = 'client' AND client_id IS NOT NULL)
            )
        );
        CREATE UNIQUE INDEX IF NOT EXISTS auth_owner ON auth_accounts(role) WHERE role = 'owner';
        CREATE UNIQUE INDEX IF NOT EXISTS auth_live_email ON auth_accounts(email) WHERE status != 'revoked';
        CREATE TABLE IF NOT EXISTS auth_attempts (
            bucket TEXT PRIMARY KEY,
            count INTEGER NOT NULL,
            reset_at INTEGER NOT NULL
        );
        SQL);
}

/** Run a check-and-write operation under a SQLite write lock. */
function auth_write(PDO $db, callable $operation): mixed
{
    $db->exec('BEGIN IMMEDIATE');
    try {
        $result = $operation();
        $db->exec('COMMIT');
        return $result;
    } catch (Throwable $exception) {
        $db->exec('ROLLBACK');
        throw $exception;
    }
}

function auth_start(array $config): void
{
    $script = (string) ($_SERVER['SCRIPT_NAME'] ?? '/');
    $path = $config['cookie_path'] ?? (rtrim(dirname($script), '/') . '/');
    if (!is_string($path) || !preg_match('#^/(?:[a-zA-Z0-9._~-]+/)*$#D', $path)) {
        problem(503, 'La configuration des sessions est indisponible.');
    }

    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_cookies', '1');
    ini_set('session.use_only_cookies', '1');
    ini_set('session.use_trans_sid', '0');
    ini_set('session.gc_maxlifetime', (string) RRV_AUTH_LIFETIME);
    session_name('RRVPortal' . substr(hash('sha256', $path), 0, 12));
    session_save_path($config['session_dir']);
    // Keep the API's explicit cache policy when PHP starts the session.
    session_cache_limiter('');
    session_set_cookie_params([
        'lifetime' => 0,
        'path' => $path,
        'domain' => '',
        'secure' => ($config['secure_cookie'] ?? true) !== false,
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
    if (!session_start()) {
        problem(503, 'Impossible d’ouvrir une session. Réessayez dans quelques instants.');
    }
    if (!isset($_SESSION['csrf']) || !is_string($_SESSION['csrf'])) {
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
    }
}

function auth_csrf(): void
{
    $token = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    if (!is_string($token) || !hash_equals($_SESSION['csrf'], $token)) {
        problem(403, 'Session expirée. Actualisez la page, puis réessayez.');
    }
}

function auth_actor(PDO $db): ?array
{
    if (!isset($_SESSION['account_id'], $_SESSION['session_version'])) {
        return null;
    }
    $now = time();
    if (($_SESSION['expires_at'] ?? 0) <= $now || ($_SESSION['idle_until'] ?? 0) <= $now) {
        auth_clear_actor();
        return null;
    }

    $query = $db->prepare(<<<'SQL'
        SELECT a.role, a.email, a.client_id
        FROM auth_accounts a
        LEFT JOIN clients c ON c.id = a.client_id
        WHERE a.id = ? AND a.session_version = ? AND a.status = 'active'
          AND (a.role = 'owner' OR c.email = a.email COLLATE NOCASE)
        SQL);
    $query->execute([$_SESSION['account_id'], $_SESSION['session_version']]);
    $account = $query->fetch();
    if ($account === false) {
        auth_clear_actor();
        return null;
    }
    $_SESSION['idle_until'] = $now + RRV_AUTH_IDLE;
    return [
        'role' => $account['role'],
        'email' => $account['email'],
        'client_id' => $account['client_id'] === null ? null : (int) $account['client_id'],
    ];
}

function auth_clear_actor(): void
{
    unset($_SESSION['account_id'], $_SESSION['session_version'], $_SESSION['expires_at'], $_SESSION['idle_until']);
}

function auth_require(PDO $db, ?string $role = null): array
{
    $actor = auth_actor($db);
    if ($actor === null) {
        problem(401, 'Connectez-vous pour accéder à cet espace.');
    }
    if ($role !== null && $actor['role'] !== $role) {
        problem(403, 'Vous n’avez pas accès à cette action.');
    }
    return $actor;
}

function auth_access(PDO $db, int $clientId): string
{
    $query = $db->prepare("SELECT status FROM auth_accounts WHERE role = 'client' AND client_id = ?");
    $query->execute([$clientId]);
    $status = $query->fetchColumn();
    return $status === false ? 'none' : $status;
}

function auth_new_session(?array $account = null): void
{
    $_SESSION = [];
    if (!session_regenerate_id(true)) {
        problem(503, 'Impossible de renouveler la session. Actualisez la page, puis réessayez.');
    }
    $_SESSION['csrf'] = bin2hex(random_bytes(32));
    if ($account !== null) {
        $now = time();
        $_SESSION['account_id'] = (int) $account['id'];
        $_SESSION['session_version'] = (int) $account['session_version'];
        $_SESSION['expires_at'] = $now + RRV_AUTH_LIFETIME;
        $_SESSION['idle_until'] = $now + RRV_AUTH_IDLE;
    }
}

function auth_email(mixed $value): ?string
{
    if (!is_string($value)) {
        return null;
    }
    $email = strtolower(trim($value));
    return strlen($email) <= 254 && filter_var($email, FILTER_VALIDATE_EMAIL) ? $email : null;
}

function auth_setup_available(PDO $db, array $config): bool
{
    $hash = $config['setup_hash'] ?? null;
    $expires = $config['setup_expires_at'] ?? null;
    return is_string($hash) && preg_match('/^[a-f0-9]{64}$/D', $hash) === 1
        && is_int($expires) && $expires > time() && auth_email($config['owner_email'] ?? null) !== null
        && $db->query("SELECT 1 FROM auth_accounts WHERE role = 'owner'")->fetchColumn() === false;
}

function auth_session_payload(PDO $db, array $config): array
{
    $user = auth_actor($db);
    return [
        'user' => $user,
        'csrf' => $_SESSION['csrf'],
        'setupAvailable' => $user === null && auth_setup_available($db, $config),
    ];
}

function auth_client_id(array $payload): int
{
    $id = $payload['client_id'] ?? null;
    if (!is_int($id) || $id < 1) {
        problem(422, 'Sélectionnez un client.');
    }
    return $id;
}

function auth_attempt(PDO $db, array $buckets): void
{
    $now = time();
    $retryAfter = auth_write($db, static function () use ($db, $buckets, $now): int {
        $cleanup = $db->prepare('DELETE FROM auth_attempts WHERE reset_at <= ?');
        $cleanup->execute([$now]);
        $lookup = $db->prepare('SELECT count, reset_at FROM auth_attempts WHERE bucket = ?');
        $retryAfter = 0;
        foreach ($buckets as $bucket => $limit) {
            $lookup->execute([$bucket]);
            $attempt = $lookup->fetch();
            if ($attempt !== false && (int) $attempt['count'] >= $limit) {
                $retryAfter = max($retryAfter, (int) $attempt['reset_at'] - $now);
            }
        }

        if ($retryAfter > 0) {
            return $retryAfter;
        }
        $add = $db->prepare(<<<'SQL'
            INSERT INTO auth_attempts (bucket, count, reset_at) VALUES (?, 1, ?)
            ON CONFLICT (bucket) DO UPDATE SET count = count + 1
            SQL);
        foreach ($buckets as $bucket => $limit) {
            $add->execute([$bucket, $now + RRV_ATTEMPT_WINDOW]);
        }
        return 0;
    });

    if ($retryAfter > 0) {
        header("Retry-After: $retryAfter");
        problem(429, 'Trop de tentatives. Patientez quelques minutes avant de réessayer.');
    }
}

function auth_source(): string
{
    $source = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    return filter_var($source, FILTER_VALIDATE_IP) ? $source : 'unknown';
}

function auth_login(PDO $db, array $config, array $payload): never
{
    $email = auth_email($payload['email'] ?? null);
    $password = $payload['password'] ?? null;
    if ($email === null || !is_string($password) || $password === ''
        || strlen($password) > RRV_PASSWORD_MAX_BYTES || str_contains($password, "\x00")) {
        problem(401, 'Adresse e-mail ou mot de passe incorrect.');
    }

    $source = auth_source();
    $perSource = hash('sha256', "login:source:$source");
    $perEmail = hash('sha256', "login:address:$email");
    $perPair = hash('sha256', "login:pair:$source:$email");
    auth_attempt($db, [$perSource => 60, $perEmail => 24, $perPair => 8]);

    $query = $db->prepare(<<<'SQL'
        SELECT a.id, a.password_hash, a.session_version
        FROM auth_accounts a
        LEFT JOIN clients c ON c.id = a.client_id
        WHERE a.email = ? AND a.status = 'active'
          AND (a.role = 'owner' OR c.email = a.email COLLATE NOCASE)
        SQL);
    $query->execute([$email]);
    $account = $query->fetch();
    $passwordHash = $account['password_hash'] ?? RRV_DUMMY_PASSWORD_HASH;
    $matches = password_verify($password, $passwordHash);
    if ($account === false || !$matches) {
        problem(401, 'Adresse e-mail ou mot de passe incorrect.');
    }
    $clear = $db->prepare('DELETE FROM auth_attempts WHERE bucket = ? OR bucket = ?');
    $clear->execute([$perPair, $perEmail]);
    auth_new_session($account);
    respond(auth_session_payload($db, $config));
}

function auth_new_password(mixed $password): string
{
    if (!is_string($password) || str_contains($password, "\x00") || preg_match('//u', $password) !== 1
        || strlen($password) > RRV_PASSWORD_MAX_BYTES || preg_match_all('/./us', $password) < RRV_PASSWORD_MIN_LENGTH) {
        problem(422, 'Choisissez un mot de passe d’au moins 12 caractères et de 72 octets maximum.');
    }
    return $password;
}

function auth_pending_account(PDO $db, string $hash): array|false
{
    $query = $db->prepare(<<<'SQL'
        SELECT a.id, a.session_version
        FROM auth_accounts a
        JOIN clients c ON c.id = a.client_id AND c.email = a.email COLLATE NOCASE
        WHERE a.invitation_hash = ? AND a.status = 'invited' AND a.invitation_expires_at > ?
        SQL);
    $query->execute([$hash, time()]);
    return $query->fetch();
}

function auth_activate(PDO $db, array $config, array $payload): never
{
    $source = auth_source();
    auth_attempt($db, [hash('sha256', "activation:$source") => 16]);

    $token = $payload['token'] ?? null;
    if (!is_string($token) || !preg_match('/^[a-f0-9]{64}$/D', $token)) {
        problem(400, 'Ce lien d’activation est invalide ou expiré.');
    }
    $password = auth_new_password($payload['password'] ?? null);
    $hash = hash('sha256', $token);
    $ownerSetup = is_string($config['setup_hash'] ?? null) && hash_equals($config['setup_hash'], $hash)
        && auth_setup_available($db, $config);
    if (!$ownerSetup && auth_pending_account($db, $hash) === false) {
        problem(400, 'Ce lien d’activation est invalide ou expiré.');
    }
    $passwordHash = password_hash($password, PASSWORD_BCRYPT, ['cost' => RRV_PASSWORD_COST]);

    $account = auth_write($db, static function () use ($db, $config, $hash, $ownerSetup, $passwordHash): array|false {
        if ($ownerSetup) {
            if (!auth_setup_available($db, $config)) {
                return false;
            }
            $insert = $db->prepare("INSERT INTO auth_accounts (role, email, status, password_hash) VALUES ('owner', ?, 'active', ?)");
            $insert->execute([auth_email($config['owner_email']), $passwordHash]);
            return ['id' => (int) $db->lastInsertId(), 'session_version' => 1];
        }

        $pending = auth_pending_account($db, $hash);
        if ($pending === false) {
            return false;
        }
        $update = $db->prepare(<<<'SQL'
            UPDATE auth_accounts
            SET status = 'active', password_hash = ?, invitation_hash = NULL,
                invitation_expires_at = NULL, session_version = session_version + 1
            WHERE id = ?
            SQL);
        $update->execute([$passwordHash, $pending['id']]);
        $pending['session_version'] = (int) $pending['session_version'] + 1;
        return $pending;
    });
    if ($account === false) {
        problem(400, 'Ce lien d’activation est invalide ou expiré.');
    }
    auth_new_session($account);
    respond(auth_session_payload($db, $config));
}

function auth_invite(PDO $db, array $actor, int $clientId): never
{
    $token = bin2hex(random_bytes(32));
    $invitationHash = hash('sha256', $token);
    $expires = time() + RRV_INVITE_LIFETIME;
    $status = auth_write($db, static function () use ($db, $actor, $clientId, $invitationHash, $expires): int {
        $query = $db->prepare('SELECT email FROM clients WHERE id = ?');
        $query->execute([$clientId]);
        $clientEmail = $query->fetchColumn();
        if ($clientEmail === false) {
            return 404;
        }
        $email = auth_email($clientEmail);
        if ($email === null || $email === $actor['email']) {
            return 422;
        }

        $invite = $db->prepare(<<<'SQL'
            INSERT INTO auth_accounts (role, email, client_id, status, invitation_hash, invitation_expires_at)
            VALUES ('client', ?, ?, 'invited', ?, ?)
            ON CONFLICT(client_id) DO UPDATE SET
                email = excluded.email, status = 'invited', password_hash = NULL,
                invitation_hash = excluded.invitation_hash,
                invitation_expires_at = excluded.invitation_expires_at,
                session_version = auth_accounts.session_version + 1
            SQL);
        $invite->execute([$email, $clientId, $invitationHash, $expires]);
        return 200;
    });
    if ($status === 404) {
        problem(404, 'Client introuvable.');
    }
    if ($status === 422) {
        problem(422, 'Utilisez une adresse e-mail différente de celle du propriétaire.');
    }
    respond(['token' => $token, 'expires_at' => gmdate(DATE_ATOM, $expires)]);
}

function auth_revoke(PDO $db, int $clientId): never
{
    $query = $db->prepare(<<<'SQL'
        UPDATE auth_accounts
        SET status = 'revoked', password_hash = NULL, invitation_hash = NULL,
            invitation_expires_at = NULL, session_version = session_version + 1
        WHERE client_id = ? AND role = 'client' AND status != 'revoked'
        SQL);
    $query->execute([$clientId]);
    respond(['ok' => true]);
}

function auth_route(PDO $db, array $config, string $action): bool
{
    switch ($action) {
        case 'session':
            respond(auth_session_payload($db, $config));
        case 'login':
            post();
            auth_login($db, $config, input());
        case 'logout':
            post();
            auth_new_session();
            respond(auth_session_payload($db, $config));
        case 'activate':
            post();
            auth_activate($db, $config, input());
        case 'invite':
            post();
            $owner = auth_require($db, 'owner');
            auth_invite($db, $owner, auth_client_id(input()));
        case 'revoke':
            post();
            auth_require($db, 'owner');
            auth_revoke($db, auth_client_id(input()));
        default:
            return false;
    }
}
