<?php

namespace App\Services\Channels;

use App\Models\Channel;
use App\Models\Contact;
use App\Models\Conversation;
use Illuminate\Support\Facades\Log;
use Symfony\Component\Mailer\Mailer;
use Symfony\Component\Mailer\Transport\Smtp\EsmtpTransport;
use Symfony\Component\Mime\Address;
use Symfony\Component\Mime\Email;

/**
 * Adapter untuk SMTP Email menggunakan Symfony Mailer.
 * Transport dikonfigurasi per-channel dari credentials_encrypted.
 *
 * Credentials:
 *   - host        : SMTP host (smtp.gmail.com, dll)
 *   - port        : SMTP port (587 = STARTTLS, 465 = SSL)
 *   - username    : Akun SMTP
 *   - password    : Password SMTP
 *   - encryption  : 'tls' | 'ssl' | 'none'
 *   - from_email  : Alamat pengirim
 *   - from_name   : Nama pengirim
 *
 * Contact identifier: contact->email
 */
class SmtpEmailAdapter implements ChannelAdapterInterface
{
    public function supports(string $channelType): bool
    {
        return $channelType === 'email';
    }

    public function send(
        Conversation $conv,
        Contact      $contact,
        Channel      $channel,
        string       $contentType,
        array        $content,
        ?string      $replyToProviderMsgId = null
    ): string {
        if (! $contact->email) {
            throw new ChannelSendException(
                'Contact has no email address for email delivery',
                channelType: 'email',
            );
        }

        $creds     = $channel->getCredentials();
        $transport = $this->buildTransport($creds);
        $mailer    = new Mailer($transport);

        $subject  = $content['subject'] ?? $conv->subject ?? 'Pesan baru dari kami';
        $htmlBody = $content['html_body'] ?? nl2br(htmlspecialchars($content['body'] ?? ''));
        $textBody = $content['body'] ?? strip_tags($content['html_body'] ?? '');

        $email = (new Email())
            ->from(new Address($creds['from_email'], $creds['from_name'] ?? ''))
            ->to(new Address($contact->email, $contact->name ?? ''))
            ->subject($subject)
            ->html($htmlBody)
            ->text($textBody);

        // Thread support via In-Reply-To header
        if ($replyToProviderMsgId !== null) {
            $email->getHeaders()->addTextHeader('In-Reply-To', $replyToProviderMsgId);
            $email->getHeaders()->addTextHeader('References', $replyToProviderMsgId);
        }

        try {
            $sentMessage = $mailer->send($email);
        } catch (\Throwable $e) {
            Log::warning('SMTP email send failed', [
                'channel_id' => $channel->id,
                'company_id' => $conv->company_id,
                'error'      => $e->getMessage(),
            ]);

            throw new ChannelSendException(
                'SMTP send failed: ' . $e->getMessage(),
                channelType: 'email',
                previous:    $e,
            );
        }

        // Kembalikan Message-ID dari header sebagai provider message ID
        $messageId = $sentMessage?->getMessageId() ?? ('email-' . now()->timestamp . '-' . uniqid());

        return $messageId;
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private function buildTransport(array $creds): EsmtpTransport
    {
        $tls  = ($creds['encryption'] ?? 'tls') !== 'none';
        $port = (int) ($creds['port'] ?? 587);

        $transport = new EsmtpTransport($creds['host'], $port, $tls);
        $transport->setUsername($creds['username']);
        $transport->setPassword($creds['password']);

        return $transport;
    }
}
