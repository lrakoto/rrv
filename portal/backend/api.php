<?php
declare(strict_types=1);

define('RRV_API', true);

ini_set('display_errors', '0');
header('Cache-Control: no-store, private, max-age=0');
header('CDN-Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('X-Robots-Tag: noindex, nofollow');
header('Referrer-Policy: no-referrer');
header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; sandbox");

function respond(array $body, int $status = 200): never
{
    $json = json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo $json;
    exit;
}

function problem(int $status, string $message): never
{
    respond(['error' => $message], $status);
}

function post(): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        header('Allow: POST');
        problem(405, 'Méthode non autorisée.');
    }
}

function input(): array
{
    $mediaType = strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0]));
    if ($mediaType !== 'application/json') {
        problem(415, 'Le formulaire doit être envoyé au format JSON.');
    }
    $payload = file_get_contents('php://input', false, null, 0, 65_537);
    if ($payload === false || strlen($payload) > 65_536) {
        problem(413, 'Ce formulaire dépasse la taille autorisée.');
    }
    try {
        $data = json_decode($payload, true, 24, JSON_THROW_ON_ERROR);
    } catch (JsonException) {
        problem(400, 'Le formulaire est illisible.');
    }
    if (!is_array($data) || !str_starts_with(ltrim($payload), '{')) {
        problem(400, 'Le formulaire est illisible.');
    }
    return $data;
}

function portal_directory(string $path): string
{
    if (is_link($path) || (!is_dir($path) && !@mkdir($path, 0700) && !is_dir($path))) {
        throw new RuntimeException('Cannot open the RRV private directory.');
    }
    $resolved = realpath($path);
    if ($resolved === false || !is_readable($resolved) || !is_writable($resolved) || (fileperms($resolved) & 0077)) {
        throw new RuntimeException('RRV private directory needs owner-only permissions.');
    }
    return $resolved;
}

function portal_config(): array
{
    $docRoot = realpath($_SERVER['DOCUMENT_ROOT'] ?? '');
    if ($docRoot === false || $docRoot === '/') {
        throw new RuntimeException('Missing document root.');
    }
    $path = getenv('RRV_DATA_DIR');
    $production = !(PHP_SAPI === 'cli-server' && getenv('RRV_LOCAL') === '1');
    $hostingHome = null;
    if (preg_match('~^(/home/[^/]+)/public_html(?:/|$)~', $docRoot, $parts)) {
        $hostingHome = $parts[1];
    }
    if ($path === false || $path === '') {
        if ($hostingHome === null) {
            throw new RuntimeException('Set RRV_DATA_DIR outside the web root.');
        }
        $path = $hostingHome . '/.rrv-data';
    }
    $path = rtrim($path, '/');
    $parent = realpath(dirname($path));
    if (!str_starts_with($path, '/') || $parent === false || in_array(basename($path), ['.', '..'], true)) {
        throw new RuntimeException('RRV_DATA_DIR needs an absolute path with an existing parent.');
    }
    $candidate = rtrim($parent, '/') . '/' . basename($path);
    $publicTree = $hostingHome === null ? $docRoot : $hostingHome . '/public_html';
    if ($candidate === $publicTree || str_starts_with($candidate, $publicTree . '/') ||
        $candidate === $docRoot || str_starts_with($candidate, $docRoot . '/')) {
        throw new RuntimeException('RRV_DATA_DIR must be outside all document roots.');
    }

    $directory = portal_directory($candidate);
    $configFile = $directory . '/setup.json';
    $databaseFile = $directory . '/portal.sqlite';
    foreach ([$configFile, $databaseFile] as $privateFile) {
        if (is_link($privateFile) || (file_exists($privateFile) && !is_file($privateFile))) {
            throw new RuntimeException('Unexpected RRV private file.');
        }
    }

    $config = [];
    if (is_file($configFile)) {
        $bytes = file_get_contents($configFile);
        if ($bytes === false) {
            throw new RuntimeException('Unable to read RRV setup configuration.');
        }
        $config = json_decode($bytes, true, 8, JSON_THROW_ON_ERROR);
        if (!is_array($config)) {
            throw new RuntimeException('Invalid RRV setup configuration.');
        }
    }
    return [
        'database' => $databaseFile,
        'session_dir' => portal_directory($directory . '/sessions'),
        'secure_cookie' => $production,
        'owner_email' => $config['owner_email'] ?? '',
        'setup_hash' => $config['setup_hash'] ?? '',
        'setup_expires_at' => $config['setup_expires_at'] ?? 0,
    ];
}

function portal_db(string $file): PDO
{
    $db = new PDO('sqlite:' . $file, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $db->exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON');
    $version = (int) $db->query('PRAGMA user_version')->fetchColumn();
    if ($version > 1) {
        throw new RuntimeException('The RRV database requires a newer app version.');
    }
    if ($version === 0) {
        $db->exec('BEGIN IMMEDIATE');
        try {
            if ((int) $db->query('PRAGMA user_version')->fetchColumn() === 0) {
                projects_schema($db);
                auth_schema($db);
                $db->exec('PRAGMA user_version = 1');
            }
            $db->exec('COMMIT');
        } catch (Throwable $error) {
            $db->exec('ROLLBACK');
            throw $error;
        }
    }
    return $db;
}

$method = $_SERVER['REQUEST_METHOD'] ?? '';
if (!in_array($method, ['GET', 'POST'], true)) {
    header('Allow: GET, POST');
    problem(405, 'Méthode non autorisée.');
}
$action = $_GET['action'] ?? '';
if (!is_string($action) || !in_array($action, [
    'session', 'login', 'logout', 'activate', 'invite', 'revoke',
    'clients', 'project', 'save_client', 'save_task', 'delete_task', 'save_document', 'delete_document', 'download',
], true)) {
    problem(404, 'Cette page est introuvable.');
}

try {
    require __DIR__ . '/__RRV_LIB__/auth.php';
    require __DIR__ . '/__RRV_LIB__/projects.php';
    umask(0077);
    $config = portal_config();
    $db = portal_db($config['database']);
    auth_start($config);
    if ($method === 'POST') {
        auth_csrf();
    }
    if (!auth_route($db, $config, $action) && !projects_route($db, $config, $action)) {
        problem(404, 'Cette page est introuvable.');
    }
} catch (Throwable $error) {
    // The private log gets the type and source location only, with no request data.
    error_log(sprintf('RRV portal: %s at %s:%d', get_class($error), basename($error->getFile()), $error->getLine()));
    problem(503, 'Le portail est momentanément indisponible. Veuillez réessayer.');
}
