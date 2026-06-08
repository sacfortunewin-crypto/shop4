<?php
declare(strict_types=1);

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';

if ($path === '/' || $path === '/index.html') {
    $indexPath = __DIR__ . '/../index.html';
    $html = file_get_contents($indexPath);

    if ($html !== false) {
        $html = str_replace(
            'https://pay.finalizeagoraa.xyz/lqv130M2Km4Zxbj',
            'checkout/',
            $html
        );

        header('Content-Type: text/html; charset=UTF-8');
        echo $html;
        return true;
    }
}

return false;
