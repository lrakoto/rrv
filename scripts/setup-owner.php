<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

function fail(string $message): never
{
    fwrite(STDERR, $message . PHP_EOL);
    exit(1);
}

if ($argc !== 4) {
    fail('Usage: php scripts/setup-owner.php <private-data-directory> <owner-email> <portal-url>');
}

$dataDirectory = rtrim($argv[1], '/');
$email = strtolower(trim($argv[2]));
$url = rtrim($argv[3], '/') . '/';
$urlParts = parse_url($url);
$localHost = in_array($urlParts['host'] ?? '', ['127.0.0.1', 'localhost'], true);
if (!filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($email) > 254 ||
    !filter_var($url, FILTER_VALIDATE_URL) ||
    array_intersect(['query', 'fragment', 'user', 'pass'], array_keys($urlParts ?: [])) ||
    (($urlParts['scheme'] ?? '') !== 'https' && !($localHost && ($urlParts['scheme'] ?? '') === 'http'))) {
    fail('Provide a valid owner email and the portal base URL. Use HTTPS outside the local preview.');
}

umask(0077);
$parent = realpath(dirname($dataDirectory));
if (!str_starts_with($dataDirectory, '/') || $parent === false ||
    in_array(basename($dataDirectory), ['', '.', '..'], true)) {
    fail('Provide an absolute private data directory with an existing parent.');
}
$dataDirectory = $parent . '/' . basename($dataDirectory);
if (preg_match('~(?:^|/)public_html(?:/|$)~', $dataDirectory)) {
    fail('Store RRV data outside public_html.');
}
if (is_link($dataDirectory) || (!is_dir($dataDirectory) && !@mkdir($dataDirectory, 0700)) ||
    (fileperms($dataDirectory) & 0077)) {
    fail('The data directory must be private and writable by the application user.');
}
$lock = fopen($dataDirectory . '/setup.lock', 'c');
if ($lock === false || !flock($lock, LOCK_EX)) {
    fail('Cannot lock the setup configuration.');
}

$database = $dataDirectory . '/portal.sqlite';
try {
    if (is_link($database)) {
        fail('The RRV database must be a regular private file.');
    }
    if (is_file($database)) {
        $pdo = new PDO('sqlite:' . $database, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $pdo->exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000');
        $accounts = $pdo->query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_accounts'")->fetchColumn();
        if ($accounts && $pdo->query("SELECT 1 FROM auth_accounts WHERE role = 'owner' LIMIT 1")->fetchColumn()) {
            fail('An owner account already exists. Setup links cannot overwrite it.');
        }
    }

    $token = bin2hex(random_bytes(32));
    $setup = json_encode([
        'owner_email' => $email,
        'setup_hash' => hash('sha256', $token),
        'setup_expires_at' => time() + 86_400,
    ], JSON_THROW_ON_ERROR);
    $temp = tempnam($dataDirectory, 'setup-');
    if ($temp === false) {
        fail('Could not write setup configuration.');
    }
    try {
        if (file_put_contents($temp, $setup) !== strlen($setup) || !rename($temp, $dataDirectory . '/setup.json')) {
            fail('Could not install setup configuration.');
        }
    } finally {
        if (is_file($temp)) {
            unlink($temp);
        }
    }
    echo $url . '#activate=' . $token . PHP_EOL;
} catch (Throwable $error) {
    fail('Could not prepare setup. Check the private directory, PHP and SQLite.');
}
