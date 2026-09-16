<?php

namespace App\Services\Channels;

use App\Models\Channel;
use App\Models\Contact;
use App\Models\Conversation;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Adapter untuk Twilio SMS API.
 *
 * Credentials:
 *   - account_sid  : Twilio Account SID (ACxxx)
 *   - auth_token   : Twilio Auth Token
 *   - from_number  : Nomor pengirim dalam format E.164 (+62...)
 *
 * Contact identifier: contact->phone (E.164)
 */
class TwilioSmsAdapter implements ChannelAdapterInterface
{
    private const BASE_URL = 'https://api.twilio.com/2010-04-01';

    public function supports(string $channelType): bool
    {
        return $channelType === 'sms';
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
        $accountSid = $creds['account_sid'];
        $authToken  = $creds['auth_token'];
        $fromNumber = $creds['from_number'];

        $recipient = $contact->phone;
        if (! $recipient) {
            throw new ChannelSendException(
                'Contact has no phone number for SMS delivery',
                channelType: 'sms',
            );
        }

        // SMS hanya support text — media juga bisa tapi kirim URL saja
        $body = match ($contentType) {
            'text'  => $content['body'],
            'image', 'video', 'audio', 'file' => $content['url'] ?? '[Media tidak tersedia]',
            default => '[Unsupported message type]',
        };

        $response = Http::withBasicAuth($accountSid, $authToken)
            ->asForm()
            ->timeout(15)
            ->post(
                self::BASE_URL . "/Accounts/{$accountSid}/Messages.json",
                [
                    'From' => $fromNumber,
                    'To'   => $recipient,
                    'Body' => $body,
                ]
            );

        if (! $response->successful()) {
            $errorCode = (string) ($response->json('code') ?? $response->status());
            $errorMsg  = $response->json('message') ?? 'Unknown Twilio error';

            Log::warning('Twilio SMS send failed', [
                'channel_id'  => $channel->id,
                'company_id'  => $conv->company_id,
                'status_code' => $response->status(),
                'error_code'  => $errorCode,
            ]);

            throw new ChannelSendException(
                "Twilio send failed: {$errorMsg}",
                channelType:       'sms',
                providerErrorCode: $errorCode,
            );
        }

        return $response->json('sid') ?? '';
    }
}
