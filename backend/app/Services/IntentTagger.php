<?php

namespace App\Services;

class IntentTagger
{
    private array $rules = [
        'billing'   => ['tagihan', 'bayar', 'invoice', 'cicilan', 'denda', 'billing', 'payment', 'pembayaran'],
        'technical' => ['error', 'gagal', 'tidak bisa', 'rusak', 'bug', 'tidak muncul', 'crash', 'masalah'],
        'complaint' => ['komplain', 'kecewa', 'marah', 'mengecewakan', 'buruk', 'jelek', 'tidak puas'],
        'inquiry'   => ['tanya', 'info', 'bagaimana', 'cara', 'bisa', 'apakah', 'berapa', 'what', 'how'],
    ];

    /**
     * Tag teks pesan dengan satu atau lebih intent label.
     * Fallback ke ['general'] jika tidak ada keyword yang cocok.
     *
     * @return string[]
     */
    public function tag(string $text): array
    {
        $lower = mb_strtolower($text);
        $tags  = [];

        foreach ($this->rules as $intent => $keywords) {
            foreach ($keywords as $keyword) {
                if (str_contains($lower, $keyword)) {
                    $tags[] = $intent;
                    break;
                }
            }
        }

        return empty($tags) ? ['general'] : array_values(array_unique($tags));
    }
}
