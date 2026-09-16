<?php

namespace App\Services\Channels;

use App\Models\Channel;
use App\Models\Contact;
use App\Models\Conversation;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Adapter untuk WhatsApp Cloud API (Meta).
 *
 * Credentials yang dibutuhkan (dari channel->getCredentials()):
 *   - phone_number_id : ID nomor pengirim di WhatsApp Business
 *   - access_token    : Graph API access token (permanent atau system user token)
 *
 * Contact identifier: contact->phone (E.164 tanpa '+', contoh: 62812345678)
 */
class WhatsAppCloudAdapter implements ChannelAdapterInterface
{
    private const API_VERSION = 'v19.0';
    private const BASE_URL    = 'https://graph.facebook.com';

    public function supports(string $channelType): bool
    {
        return $channelType === 'whatsapp';
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
        $phoneNumberId = $creds['phone_number_id'];
        $accessToken   = $creds['access_token'];

        // Normalkan nomor penerima: E.164 tanpa '+'
        $recipient = ltrim($contact->phone ?? '', '+');

        $body = $this->buildBody($contentType, $content, $recipient, $replyToProviderMsgId);

        $response = Http::withToken($accessToken)
            ->timeout(15)
            ->post(
                self::BASE_URL . '/' . self::API_VERSION . "/{$phoneNumberId}/messages",
                $body
            );

        if (! $response->successful()) {
            $errorData  = $response->json('error', []);
            $errorCode  = (string) ($errorData['code'] ?? $response->status());
            $errorMsg   = $errorData['message'] ?? 'Unknown WhatsApp API error';

            Log::warning('WhatsApp Cloud API send failed', [
                'channel_id'  => $channel->id,
                'company_id'  => $conv->company_id,
                'status_code' => $response->status(),
                'error_code'  => $errorCode,
            ]);

            throw new ChannelSendException(
                "WhatsApp send failed: {$errorMsg}",
                channelType:        'whatsapp',
                providerErrorCode:  $errorCode,
            );
        }

        // Response: { messages: [{ id: "wamid.xxx" }] }
        $providerMsgId = $response->json('messages.0.id') ?? '';

        return $providerMsgId;
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private function buildBody(
        string  $contentType,
        array   $content,
        string  $recipient,
        ?string $replyToProviderMsgId
    ): array {
        $body = [
            'messaging_product' => 'whatsapp',
            'recipient_type'    => 'individual',
            'to'                => $recipient,
        ];

        match ($contentType) {
            'text' => $body += [
                'type' => 'text',
                'text' => ['body' => $content['body'], 'preview_url' => false],
            ],
            'image' => $body += [
                'type'  => 'image',
                'image' => ['link' => $content['url'], 'caption' => $content['caption'] ?? ''],
            ],
            'audio' => $body += [
                'type'  => 'audio',
                'audio' => ['link' => $content['url']],
            ],
            'video' => $body += [
                'type'  => 'video',
                'video' => ['link' => $content['url'], 'caption' => $content['caption'] ?? ''],
            ],
            'file' => $body += [
                'type'     => 'document',
                'document' => [
                    'link'     => $content['url'],
                    'filename' => $content['filename'] ?? 'file',
                    'caption'  => $content['caption'] ?? '',
                ],
            ],
            default => $body += [
                'type' => 'text',
                'text' => ['body' => '[Unsupported message type]', 'preview_url' => false],
            ],
        };

        if ($replyToProviderMsgId !== null) {
            $body['context'] = ['message_id' => $replyToProviderMsgId];
        }

        return $body;
    }
}
