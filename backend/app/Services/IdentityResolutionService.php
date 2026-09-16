<?php

namespace App\Services;

use App\Models\Contact;
use App\Models\ContactChannelIdentity;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class IdentityResolutionService
{
    /**
     * Temukan atau buat Contact dari sender identifier.
     *
     * Algoritma (ikuti urutan ini):
     * 1. Cari di contact_channel_identities (exact match)
     * 2. Cari via email/phone (cross-channel merge kandidat)
     * 3. Buat Contact + Identity baru dalam satu transaksi
     *
     * Race condition di STEP 3 di-handle dengan catch IntegrityConstraint + retry.
     */
    public function resolve(
        string $companyId,
        string $channelType,
        string $externalId,
        array  $profile
    ): Contact {
        // STEP 1 — Lookup by channel identity
        $identity = ContactChannelIdentity::where('company_id',   $companyId)
            ->where('channel_type', $channelType)
            ->where('external_id',  $externalId)
            ->first();

        if ($identity) {
            $contact = Contact::withoutGlobalScopes()
                ->where('company_id', $companyId)
                ->find($identity->contact_id);

            $this->updateIdentityProfileIfChanged($identity, $profile);
            return $contact;
        }

        // STEP 2 — Cross-channel merge via email/phone
        $existing = $this->findByEmailOrPhone($companyId, $channelType, $externalId);

        if ($existing) {
            $this->addIdentityToContact($existing, $companyId, $channelType, $externalId, $profile);
            return $existing;
        }

        // STEP 3 — Buat Contact baru + Identity baru
        return $this->createContactWithIdentity($companyId, $channelType, $externalId, $profile);
    }

    // ── Private Helpers ───────────────────────────────────────────────────────

    private function findByEmailOrPhone(string $companyId, string $channelType, string $externalId): ?Contact
    {
        $query = Contact::withoutGlobalScopes()->where('company_id', $companyId);

        if ($channelType === 'email') {
            return $query->where('email', $externalId)->first();
        }

        if (in_array($channelType, ['whatsapp', 'sms'])) {
            return $query->where('phone', $externalId)->first();
        }

        return null;
    }

    private function addIdentityToContact(
        Contact $contact,
        string  $companyId,
        string  $channelType,
        string  $externalId,
        array   $profile
    ): void {
        // Safe insert — bisa sudah ada jika race condition di STEP 2
        try {
            ContactChannelIdentity::create([
                'contact_id'   => $contact->id,
                'company_id'   => $companyId,
                'channel_type' => $channelType,
                'external_id'  => $externalId,
                'display_name' => $profile['name'] ?? null,
                'avatar_url'   => $profile['avatar'] ?? null,
                'raw_profile'  => $profile,
            ]);
        } catch (QueryException $e) {
            if ($e->getCode() !== '23000') throw $e;
            // Duplikat — identity sudah ditambahkan oleh worker lain, abaikan
        }
    }

    private function createContactWithIdentity(
        string $companyId,
        string $channelType,
        string $externalId,
        array  $profile
    ): Contact {
        try {
            return DB::transaction(function () use ($companyId, $channelType, $externalId, $profile) {
                $contact = Contact::create([
                    'id'         => Str::uuid()->toString(),
                    'company_id' => $companyId,
                    'name'       => $profile['name'] ?? null,
                    'email'      => $channelType === 'email' ? $externalId : null,
                    'phone'      => in_array($channelType, ['whatsapp', 'sms']) ? $externalId : null,
                ]);

                ContactChannelIdentity::create([
                    'contact_id'   => $contact->id,
                    'company_id'   => $companyId,
                    'channel_type' => $channelType,
                    'external_id'  => $externalId,
                    'display_name' => $profile['name'] ?? null,
                    'avatar_url'   => $profile['avatar'] ?? null,
                    'raw_profile'  => $profile,
                ]);

                return $contact;
            });
        } catch (QueryException $e) {
            // Kode 23000 = duplicate key — worker lain sudah buat contact ini
            // Re-query dan return contact yang sudah ada
            if ($e->getCode() === '23000') {
                return $this->resolve($companyId, $channelType, $externalId, $profile);
            }
            throw $e;
        }
    }

    private function updateIdentityProfileIfChanged(ContactChannelIdentity $identity, array $profile): void
    {
        $newName = $profile['name'] ?? null;

        if ($newName && $identity->display_name !== $newName) {
            $identity->update(['display_name' => $newName]);

            // Jangan overwrite nama contact jika sudah diisi manual oleh agen
            $contact = Contact::withoutGlobalScopes()->find($identity->contact_id);
            if ($contact && ! $contact->name_is_manual && ! $contact->name) {
                $contact->update(['name' => $newName]);
            }
        }
    }
}
