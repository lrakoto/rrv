<?php
declare(strict_types=1);

if (!defined('RRV_API')) {
    http_response_code(404);
    exit;
}

const PROJECT_CLIENT_STATUSES = ['planning', 'active', 'on_hold', 'complete'];
const PROJECT_DOCUMENT_KINDS = ['contract', 'permit'];
const PROJECT_DOCUMENT_STATUSES = ['draft', 'pending', 'approved', 'expired'];
const PROJECT_PDF_LIMIT = 8 * 1024 * 1024;

function projects_schema(PDO $db): void
{
    $db->exec(<<<'SQL'
        CREATE TABLE IF NOT EXISTS clients (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT NOT NULL COLLATE NOCASE UNIQUE,
            project TEXT NOT NULL,
            location TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'planning'
                CHECK (status IN ('planning', 'active', 'on_hold', 'complete')),
            progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
            notes TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        );

        CREATE TABLE IF NOT EXISTS project_tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_id INTEGER NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
            shared INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1)),
            due_date TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS project_tasks_by_client ON project_tasks (client_id);

        CREATE TABLE IF NOT EXISTS project_documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_id INTEGER NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK (kind IN ('contract', 'permit')),
            title TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'pending', 'approved', 'expired')),
            reference TEXT NOT NULL DEFAULT '',
            due_date TEXT NOT NULL DEFAULT '',
            shared INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1))
        );
        CREATE INDEX IF NOT EXISTS project_documents_by_client ON project_documents (client_id);

        CREATE TABLE IF NOT EXISTS project_document_files (
            document_id INTEGER PRIMARY KEY REFERENCES project_documents (id) ON DELETE CASCADE,
            filename TEXT NOT NULL,
            contents BLOB NOT NULL
        );
        SQL);
}

function projects_route(PDO $db, array $config, string $action): bool
{
    switch ($action) {
        case 'clients':
            project_get();
            auth_require($db, 'owner');
            $clients = $db->query('SELECT * FROM clients ORDER BY name COLLATE NOCASE, id')
                ->fetchAll(PDO::FETCH_ASSOC);
            respond(['clients' => array_map(
                static fn(array $client): array => project_client_payload($db, $client, true),
                $clients
            )]);
        case 'project':
            project_get();
            $actor = auth_require($db);
            $id = project_integer($_GET, 'id', 1);
            $owner = $actor['role'] === 'owner';
            if (!$owner && $id !== $actor['client_id']) {
                problem(404, 'Projet introuvable.');
            }
            respond(project_read($db, $id, $owner));
        case 'save_client':
            post();
            auth_require($db, 'owner');
            respond(['id' => project_save_client($db, input())]);
        case 'save_task':
            post();
            auth_require($db, 'owner');
            respond(['id' => project_save_task($db, input())]);
        case 'delete_task':
            post();
            auth_require($db, 'owner');
            project_delete_record($db, 'project_tasks', input());
            respond(['ok' => true]);
        case 'save_document':
            post();
            auth_require($db, 'owner');
            if (empty($_POST) && (int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > PROJECT_PDF_LIMIT) {
                problem(413, 'Le PDF ne doit pas dépasser 8 Mio.');
            }
            respond(['id' => project_save_document($db, $_POST, $_FILES['file'] ?? null)]);
        case 'delete_document':
            post();
            auth_require($db, 'owner');
            project_delete_record($db, 'project_documents', input());
            respond(['ok' => true]);
        case 'download':
            project_get();
            $actor = auth_require($db);
            project_download($db, project_integer($_GET, 'id', 1), $actor);
    }
    return false;
}

function project_get(): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
        problem(405, 'Méthode non autorisée.');
    }
}

function project_integer(
    array $fields,
    string $key,
    int $min,
    int $max = PHP_INT_MAX
): int {
    $value = $fields[$key] ?? null;
    if (!is_int($value) && (!is_string($value) || !ctype_digit($value))) {
        problem(422, 'Un nombre fourni est invalide.');
    }
    $number = filter_var($value, FILTER_VALIDATE_INT, ['options' => [
        'min_range' => $min,
        'max_range' => $max,
    ]]);
    if ($number === false) {
        problem(422, 'Un nombre fourni est hors limites.');
    }
    return $number;
}

function project_optional_id(array $fields): ?int
{
    return ($fields['id'] ?? '') === '' ? null : project_integer($fields, 'id', 1);
}

function project_text(array $fields, string $key, int $limit, bool $required = false): string
{
    $value = $fields[$key] ?? '';
    if (!is_string($value) || !preg_match('//u', $value) || str_contains($value, "\0")) {
        problem(422, 'Un champ de texte est invalide.');
    }
    $value = trim($value);
    if (strlen($value) > $limit || ($required && $value === '')) {
        problem(422, 'Vérifiez les champs requis et leur longueur.');
    }
    return $value;
}

function project_choice(array $fields, string $key, array $choices): string
{
    $value = $fields[$key] ?? null;
    if (!is_string($value) || !in_array($value, $choices, true)) {
        problem(422, 'Une option sélectionnée est invalide.');
    }
    return $value;
}

function project_flag(array $fields, string $key): int
{
    $value = $fields[$key] ?? false;
    if (in_array($value, [true, 1, '1', 'true'], true)) {
        return 1;
    }
    if (in_array($value, [false, 0, '0', 'false'], true)) {
        return 0;
    }
    problem(422, 'Une option de partage ou de suivi est invalide.');
}

function project_date(array $fields): string
{
    $value = project_text($fields, 'due_date', 10);
    if ($value === '') {
        return '';
    }
    $date = DateTimeImmutable::createFromFormat('!Y-m-d', $value);
    if ($date === false || $date->format('Y-m-d') !== $value || str_starts_with($value, '0000')) {
        problem(422, 'La date doit être valide.');
    }
    return $value;
}

function project_find_client(PDO $db, int $id): array
{
    $query = $db->prepare('SELECT * FROM clients WHERE id = ?');
    $query->execute([$id]);
    $client = $query->fetch(PDO::FETCH_ASSOC);
    if ($client === false) {
        problem(404, 'Projet introuvable.');
    }
    return $client;
}

function project_client_payload(PDO $db, array $client, bool $owner): array
{
    $client['id'] = (int) $client['id'];
    $client['progress'] = (int) $client['progress'];
    if ($owner) {
        $client['access'] = auth_access($db, $client['id']);
    } else {
        unset($client['created_at']);
    }
    return $client;
}

function project_read(PDO $db, int $id, bool $owner): array
{
    $client = project_client_payload($db, project_find_client($db, $id), $owner);
    $taskQuery = $db->prepare(
        "SELECT id, title, done, shared, due_date FROM project_tasks
         WHERE client_id = :client_id AND (:owner = 1 OR shared = 1)
         ORDER BY done, due_date = '', due_date, id DESC"
    );
    $taskQuery->bindValue(':client_id', $id, PDO::PARAM_INT);
    $taskQuery->bindValue(':owner', (int) $owner, PDO::PARAM_INT);
    $taskQuery->execute();
    $tasks = $taskQuery->fetchAll(PDO::FETCH_ASSOC);
    foreach ($tasks as &$task) {
        $task['id'] = (int) $task['id'];
        $task['done'] = (bool) $task['done'];
        $task['shared'] = (bool) $task['shared'];
    }
    unset($task);

    $documentQuery = $db->prepare(
        "SELECT d.id, d.kind, d.title, d.status, d.reference, d.due_date, d.shared,
                f.document_id IS NOT NULL AS has_file, COALESCE(f.filename, '') AS filename
         FROM project_documents d
         LEFT JOIN project_document_files f ON f.document_id = d.id
         WHERE d.client_id = :client_id AND (:owner = 1 OR d.shared = 1)
         ORDER BY d.kind, d.due_date = '', d.due_date, d.id DESC"
    );
    $documentQuery->bindValue(':client_id', $id, PDO::PARAM_INT);
    $documentQuery->bindValue(':owner', (int) $owner, PDO::PARAM_INT);
    $documentQuery->execute();
    $documents = $documentQuery->fetchAll(PDO::FETCH_ASSOC);
    foreach ($documents as &$document) {
        $document['id'] = (int) $document['id'];
        $document['shared'] = (bool) $document['shared'];
        $document['has_file'] = (bool) $document['has_file'];
    }
    unset($document);

    return ['client' => $client, 'tasks' => $tasks, 'documents' => $documents];
}

function project_save_client(PDO $db, array $fields): int
{
    $id = project_optional_id($fields);
    $email = strtolower(project_text($fields, 'email', 254, true));
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        problem(422, 'Saisissez une adresse e-mail valide.');
    }

    $data = [
        'name' => project_text($fields, 'name', 160, true),
        'email' => $email,
        'project' => project_text($fields, 'project', 200, true),
        'location' => project_text($fields, 'location', 200),
        'status' => project_choice($fields, 'status', PROJECT_CLIENT_STATUSES),
        'progress' => project_integer($fields, 'progress', 0, 100),
        'notes' => project_text($fields, 'notes', 5000),
    ];

    // Take the write lock before checking access, so an invitation cannot be
    // created with a stale email while the record is being edited.
    $db->exec('BEGIN IMMEDIATE');
    try {
        $duplicate = $db->prepare('SELECT id FROM clients WHERE email = ? AND id <> ?');
        $duplicate->execute([$email, $id ?? 0]);
        if ($duplicate->fetchColumn() !== false) {
            problem(409, 'Un client utilise déjà cette adresse e-mail.');
        }

        if ($id === null) {
            $statement = $db->prepare(
                'INSERT INTO clients (name, email, project, location, status, progress, notes)
                 VALUES (:name, :email, :project, :location, :status, :progress, :notes)'
            );
            $statement->execute($data);
            $id = (int) $db->lastInsertId();
        } else {
            $statement = $db->prepare('SELECT email FROM clients WHERE id = ?');
            $statement->execute([$id]);
            $previousEmail = $statement->fetchColumn();
            if ($previousEmail === false) {
                problem(404, 'Projet introuvable.');
            }
            if ($previousEmail !== $email && !in_array(auth_access($db, $id), ['none', 'revoked'], true)) {
                problem(409, 'Révoquez l’accès du client avant de modifier son adresse e-mail.');
            }

            $statement = $db->prepare(
                "UPDATE clients SET name = :name, email = :email, project = :project,
                 location = :location, status = :status, progress = :progress, notes = :notes,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = :id"
            );
            $statement->execute($data + ['id' => $id]);
        }
        $db->exec('COMMIT');
    } catch (Throwable $exception) {
        $db->exec('ROLLBACK');
        throw $exception;
    }
    return $id;
}

function project_save_task(PDO $db, array $fields): int
{
    $id = project_optional_id($fields);
    $clientId = project_integer($fields, 'client_id', 1);
    $data = [
        'client_id' => $clientId,
        'title' => project_text($fields, 'title', 200, true),
        'done' => project_flag($fields, 'done'),
        'shared' => project_flag($fields, 'shared'),
        'due_date' => project_date($fields),
    ];
    project_find_client($db, $clientId);
    if ($id === null) {
        $query = $db->prepare(
            'INSERT INTO project_tasks (client_id, title, done, shared, due_date)
             VALUES (:client_id, :title, :done, :shared, :due_date)'
        );
        $query->execute($data);
        return (int) $db->lastInsertId();
    }

    $query = $db->prepare(
        'UPDATE project_tasks SET title = :title, done = :done, shared = :shared, due_date = :due_date
         WHERE id = :id AND client_id = :client_id'
    );
    $query->execute($data + ['id' => $id]);
    if ($query->rowCount() === 0) {
        problem(404, 'Tâche introuvable.');
    }
    return $id;
}

function project_read_upload(mixed $file): ?array
{
    if ($file === null || (is_array($file) && ($file['error'] ?? null) === UPLOAD_ERR_NO_FILE)) {
        return null;
    }
    if (!is_array($file) || !isset($file['error']) || is_array($file['error'])) {
        problem(422, 'Le fichier envoyé est invalide.');
    }
    if (in_array($file['error'], [UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE], true)) {
        problem(413, 'Le PDF ne doit pas dépasser 8 Mio.');
    }
    if ($file['error'] !== UPLOAD_ERR_OK || !isset($file['tmp_name'], $file['name'])
        || !is_string($file['tmp_name']) || !is_string($file['name'])
        || !is_uploaded_file($file['tmp_name'])) {
        problem(422, 'Le fichier n’a pas pu être reçu.');
    }

    $bytes = file_get_contents($file['tmp_name'], false, null, 0, PROJECT_PDF_LIMIT + 1);
    if ($bytes === false) {
        problem(422, 'Le fichier n’a pas pu être lu.');
    }
    if (strlen($bytes) > PROJECT_PDF_LIMIT) {
        problem(413, 'Le PDF ne doit pas dépasser 8 Mio.');
    }
    if (!preg_match('/^%PDF-[12]\.[0-9]/D', $bytes)
        || (new finfo(FILEINFO_MIME_TYPE))->buffer($bytes) !== 'application/pdf') {
        problem(422, 'Seuls les fichiers PDF sont acceptés.');
    }

    $name = basename(str_replace('\\', '/', $file['name']));
    $stem = preg_replace('/\.pdf$/iD', '', $name);
    $stem = trim(preg_replace('/[^A-Za-z0-9._-]+/', '-', $stem ?? ''), '._-');
    return ['filename' => ($stem === '' ? 'document' : substr($stem, 0, 120)) . '.pdf', 'contents' => $bytes];
}

function project_save_document(PDO $db, array $fields, mixed $upload): int
{
    $id = project_optional_id($fields);
    $clientId = project_integer($fields, 'client_id', 1);
    $data = [
        'client_id' => $clientId,
        'kind' => project_choice($fields, 'kind', PROJECT_DOCUMENT_KINDS),
        'title' => project_text($fields, 'title', 200, true),
        'status' => project_choice($fields, 'status', PROJECT_DOCUMENT_STATUSES),
        'reference' => project_text($fields, 'reference', 200),
        'due_date' => project_date($fields),
        'shared' => project_flag($fields, 'shared'),
    ];
    $file = project_read_upload($upload);
    project_find_client($db, $clientId);
    $db->beginTransaction();
    try {
        if ($id === null) {
            $query = $db->prepare(
                'INSERT INTO project_documents (client_id, kind, title, status, reference, due_date, shared)
                 VALUES (:client_id, :kind, :title, :status, :reference, :due_date, :shared)'
            );
            $query->execute($data);
            $id = (int) $db->lastInsertId();
        } else {
            $query = $db->prepare(
                'UPDATE project_documents SET kind = :kind, title = :title, status = :status,
                 reference = :reference, due_date = :due_date, shared = :shared
                 WHERE id = :id AND client_id = :client_id'
            );
            $query->execute($data + ['id' => $id]);
            if ($query->rowCount() === 0) {
                problem(404, 'Document introuvable.');
            }
        }

        if ($file !== null) {
            $query = $db->prepare(
                'INSERT INTO project_document_files (document_id, filename, contents) VALUES (?, ?, ?)
                 ON CONFLICT(document_id) DO UPDATE SET filename = excluded.filename, contents = excluded.contents'
            );
            $query->bindValue(1, $id, PDO::PARAM_INT);
            $query->bindValue(2, $file['filename'], PDO::PARAM_STR);
            $query->bindValue(3, $file['contents'], PDO::PARAM_LOB);
            $query->execute();
        }
        $db->commit();
    } catch (Throwable $exception) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $exception;
    }
    return $id;
}

function project_delete_record(PDO $db, string $table, array $fields): void
{
    $sql = match ($table) {
        'project_tasks' => 'DELETE FROM project_tasks WHERE id = ? AND client_id = ?',
        'project_documents' => 'DELETE FROM project_documents WHERE id = ? AND client_id = ?',
    };
    $statement = $db->prepare($sql);
    $statement->execute([project_integer($fields, 'id', 1), project_integer($fields, 'client_id', 1)]);
    if ($statement->rowCount() === 0) {
        problem(404, 'Élément introuvable.');
    }
}

function project_download(PDO $db, int $id, array $actor): never
{
    // Restrict in SQL so private PDF contents are never loaded for another client.
    $query = $db->prepare(
        'SELECT f.filename, f.contents FROM project_document_files f
         JOIN project_documents d ON d.id = f.document_id
         WHERE d.id = :id AND (:owner = 1 OR (d.client_id = :client_id AND d.shared = 1))'
    );
    $query->bindValue(':id', $id, PDO::PARAM_INT);
    $query->bindValue(':owner', (int) ($actor['role'] === 'owner'), PDO::PARAM_INT);
    $query->bindValue(':client_id', (int) ($actor['client_id'] ?? 0), PDO::PARAM_INT);
    $query->execute();
    $file = $query->fetch(PDO::FETCH_ASSOC);
    if ($file === false) {
        problem(404, 'Fichier introuvable.');
    }
    $bytes = $file['contents'];
    if (is_resource($bytes)) {
        $bytes = stream_get_contents($bytes, PROJECT_PDF_LIMIT + 1);
    }
    if (!is_string($bytes) || strlen($bytes) > PROJECT_PDF_LIMIT) {
        problem(500, 'Le fichier n’a pas pu être lu.');
    }
    $filename = preg_match('/^[A-Za-z0-9._-]+\.pdf$/D', $file['filename'])
        ? $file['filename']
        : 'document.pdf';
    header('Content-Type: application/pdf');
    header('Content-Disposition: attachment; filename="' . $filename . '"');
    header('Content-Length: ' . strlen($bytes));
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: private, no-store');
    echo $bytes;
    exit;
}
