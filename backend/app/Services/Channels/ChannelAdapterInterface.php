<?php

namespace App\Services\Channels;

use App\Models\Channel;
use App\Models\Contact;
use App\Models\Conversation;

/**
 * Kontrak untuk setiap channel adapter outbound.
 *
 * Implementasi HARUS:
 * - Decrypt credentials via $channel->getCredentials() — JANGAN akses credentials_encrypted langsung
 * - Tidak log content pesan — berisi PII
 * - Throw ChannelSendException bila pengiriman gagal (bukan generic Exception)
 */
interface ChannelAdapterInterface
{
    /**
     * Kirim pesan ke channel dan kembalikan provider message ID.
     *
     * @param  Conversation $conv        Conversation aktif (sudah ada channel_id)
     * @param  Contact      $contact     Penerima (berisi phone, email, dll)
     * @param  Channel      $channel     Channel yang digunakan untuk mengirim
     * @param  string       $contentType text | image | audio | video | file
     * @param  array        $content     Sesuai content_type (body, url, filename, dll)
     * @param  string|null  $replyToProviderMsgId  ID pesan yang di-quote (opsional)
     * @return string Provider message ID
     *
     * @throws ChannelSendException
     */
    public function send(
        Conversation $conv,
        Contact      $contact,
        Channel      $channel,
        string       $contentType,
        array        $content,
        ?string      $replyToProviderMsgId = null
    ): string;

    /**
     * Apakah adapter ini menangani channel type ini?
     */
    public function supports(string $channelType): bool;
}
