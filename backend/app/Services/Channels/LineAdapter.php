<?php

namespace App\Services\Channels;

use App\Models\Channel;
use App\Models\Contact;
use App\Models\Conversation;
use App\Models\ContactChannelIdentity;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Adapter untuk LINE Messaging API.
 *
 * Credentials:
 *   - channel_access_token : Long-lived channel access token dari LINE Developers Console
 *
 * Contact identifier: ContactChannelIdentity.external_id (LINE user ID, format: U...)
 */
class LineAdapter implements ChannelAdapterInterface
{
    private const BASE_URL = 'https://api.line.me/v2/bot/message';

    public function supports(string $channelType): bool
    {
        return $channelType === 'line';
    }

    public function send(
        Conversation $conv,
        Contact      $contact,
        Channel      $channel,
        string       $contentType,
        array        $content,
        ?string      $replyToProviderMsgId = null
    ): string {
        $creds = $channel->getCredentials();
        $token = $creds['channel_access_token'];

        // Ambil LINE user ID dari contact_channel_identities
        $identity = ContactChannelIdentity::where('contact_id',   $contact->id)
            ->where('company_id',   $conv->company_id)
            ->where('channel_type', 'line')
            ->first();

        if (! $identity) {
            throw new ChannelSendException(
                'LINE user ID not found for contact',
                channelType: 'line',
            );
        }

        $lineUserId = $identity->external_id;
        $messages   = [$this->buildMessage($contentType, $content)];

        // Gunakan reply jika ada token, push jika tidak
        if ($replyToProviderMsgId !== null) {
            $response = Http::withToken($token)
                ->timeout(15)
                ->post(self::BASE_URL . '/reply', [
                    'replyToken' => $replyToProviderMsgId,
                    'messages'   => $messages,
                ]);
        } else {
            $response = Http::withToken($token)
                ->timeout(15)
                ->post(self::BASE_URL . '/push', [
                    'to'       => $lineUserId,
                    'messages' => $messages,
                ]);
        }

        if (! $response->successful()) {
            $errorMsg = $response->json('message') ?? 'Unknown LINE API error';

            Log::warning('LINE API send failed', [
                'channel_id'  => $channel->id,
                'company_id'  => $conv->company_id,
                'status_code' => $response->status(),
            ]);

            throw new ChannelSendException(
                "LINE send failed: {$errorMsg}",
                channelType:       'line',
                providerErrorCode: (string) $response->status(),
            );
        }

        // LINE reply/push tidak mengembalikan message ID — gunakan sentinel
        $sentMessages = $response->json('sentMessages', []);
        return $sentMessages[0]['id'] ?? ('line-push-' . now()->timestamp);
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private function buildMessage(string $contentType, array $content): array
    {
        return match ($contentType) {
            'text' => [
                'type' => 'text',
                'text' => $content['body'],
            ],
            'image' => [
                'type'               => 'image',
                'originalContentUrl' => $content['url'],
                'previewImageUrl'    => $content['preview_url'] ?? $content['url'],
            ],
            'audio' => [
                'type'       => 'audio',
                'originalContentUrl' => $content['url'],
                'duration'   => $content['duration_ms'] ?? 0,
            ],
            'video' => [
                'type'               => 'video',
                'originalContentUrl' => $content['url'],
                'previewImageUrl'    => $content['preview_url'] ?? '',
            ],
            'file' => [
                'type' => 'text',
                'text' => '[File: ' . ($content['filename'] ?? 'file') . '] ' . ($content['url'] ?? ''),
            ],
            default => [
                'type' => 'text',
                'text' => '[Unsupported message type]',
            ],
        };
    }
}
