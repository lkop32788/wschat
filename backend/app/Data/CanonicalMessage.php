<?php

namespace App\Data;

/**
 * DTO untuk canonical message dari RabbitMQ (output Phase 2 gateway).
 * Immutable value object — tidak ada setter setelah konstruksi.
 */
final readonly class CanonicalMessage
{
    public function __construct(
        public string  $event_id,
        public string  $company_id,
        public string  $channel_id,
        public string  $channel_type,
        public string  $direction,
        public string  $idempotency_key,
        public string  $sender_external_id,
        public ?string $sender_name,
        public ?string $sender_avatar,
        public string  $content_type,
        public array   $content,
        public ?string $quoted_message_id,
        public ?string $conversation_ref_id,
        public string  $provider_timestamp,
        public string  $received_at,
        public array   $raw_payload,
    ) {}

    public static function fromArray(array $data): self
    {
        return new self(
            event_id:            $data['event_id'],
            company_id:          $data['company_id'],
            channel_id:          $data['channel_id'],
            channel_type:        $data['channel_type'],
            direction:           $data['direction'],
            idempotency_key:     $data['idempotency_key'],
            sender_external_id:  $data['sender_external_id'],
            sender_name:         $data['sender_name']         ?? null,
            sender_avatar:       $data['sender_avatar']       ?? null,
            content_type:        $data['content_type'],
            content:             $data['content']             ?? [],
            quoted_message_id:   $data['quoted_message_id']   ?? null,
            conversation_ref_id: $data['conversation_ref_id'] ?? null,
            provider_timestamp:  $data['provider_timestamp'],
            received_at:         $data['received_at'],
            raw_payload:         $data['raw_payload']         ?? [],
        );
    }

    public function getPreview(): string
    {
        return match ($this->content_type) {
            'text'     => mb_substr($this->content['body'] ?? '', 0, 150),
            'image'    => '[Foto]',
            'audio'    => '[Pesan suara]',
            'video'    => '[Video]',
            'file'     => '[File: ' . ($this->content['filename'] ?? 'unknown') . ']',
            'location' => '[Lokasi]',
            'sticker'  => '[Sticker]',
            default    => '[Pesan]',
        };
    }
}
