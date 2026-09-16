<?php

return [
    'host'     => env('RABBITMQ_HOST', 'localhost'),
    'port'     => (int) env('RABBITMQ_PORT', 5672),
    'user'     => env('RABBITMQ_USER', 'guest'),
    'password' => env('RABBITMQ_PASSWORD', 'guest'),
    'vhost'    => env('RABBITMQ_VHOST', '/'),

    // Exchange names — harus sinkron dengan Phase 2 gateway (amqpClient.js)
    'exchange' => 'messages',
    'dlx'      => 'messages.dlx',

    // Queue names per channel type
    'queues' => [
        'whatsapp' => 'inbound.whatsapp',
        'line'     => 'inbound.line',
        'email'    => 'inbound.email',
        'telegram' => 'inbound.telegram',
    ],
];
