<?php

namespace App\Services\Channels;

use RuntimeException;

class ChannelSendException extends RuntimeException
{
    public function __construct(
        string     $message,
        public readonly string $channelType,
        public readonly ?string $providerErrorCode = null,
        ?\Throwable $previous = null
    ) {
        parent::__construct($message, 0, $previous);
    }
}
