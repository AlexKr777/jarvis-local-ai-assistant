import unittest
from types import SimpleNamespace

from parser_worker.telegram_organizer import (
    OrganizationFailure,
    TelegramChatOrganizer,
)


class DialogFilter:
    def __init__(self, filter_id=7, title="парсер", include_peers=None, **metadata):
        self.id = filter_id
        self.title = title
        self.include_peers = list(include_peers or [])
        self.pinned_peers = list(metadata.pop("pinned_peers", []))
        self.exclude_peers = list(metadata.pop("exclude_peers", []))
        self.exclude_archived = metadata.pop("exclude_archived", False)
        for key, value in metadata.items():
            setattr(self, key, value)


class DialogFilterChatlist:
    def __init__(self, filter_id=9, title=None, include_peers=None, **metadata):
        self.id = filter_id
        self.title = title or SimpleNamespace(text="парсер")
        self.include_peers = list(include_peers or [])
        self.pinned_peers = list(metadata.pop("pinned_peers", []))
        for key, value in metadata.items():
            setattr(self, key, value)


def peer(peer_id):
    return SimpleNamespace(channel_id=peer_id)


class FakeGateway:
    def __init__(self, filters=None, folder_ids=None):
        self.filters = list(filters or [])
        self.folder_ids = dict(folder_ids or {})
        self.calls = []
        self.verify_folder_membership = True

    async def resolve_input_peer(self, group):
        resolved = peer(int(group["telegramGroupId"]))
        self.calls.append(("resolve", resolved.channel_id))
        return resolved

    async def get_dialog_filters(self):
        self.calls.append(("get_filters",))
        return self.filters

    async def update_dialog_filter(self, filter_id, dialog_filter):
        self.calls.append(("update_filter", filter_id))

    async def create_dialog_filter(self, title, include_peers):
        self.calls.append(("create_filter", title, [p.channel_id for p in include_peers]))
        created = DialogFilter(filter_id=12, title=title, include_peers=include_peers)
        self.filters.append(created)
        return created

    async def get_peer_folder_ids(self, peers):
        self.calls.append(("get_peer_folders", [p.channel_id for p in peers]))
        return {("channel", p.channel_id): self.folder_ids.get(p.channel_id) for p in peers}

    async def archive_peers(self, peers):
        self.calls.append(("archive", [p.channel_id for p in peers]))
        for item in peers:
            self.folder_ids[item.channel_id] = 1


class TelegramChatOrganizerTests(unittest.IsolatedAsyncioTestCase):
    def group(self, telegram_id=200, title="New Group"):
        return {"id": f"group-{telegram_id}", "telegramGroupId": str(telegram_id), "title": title}

    async def test_ordinary_filter_preserves_metadata_and_existing_peers(self):
        existing = peer(100)
        excluded = peer(300)
        folder = DialogFilter(
            include_peers=[existing], pinned_peers=[existing], exclude_peers=[excluded],
            exclude_archived=True, emoticon="📡", color=5, contacts=True,
        )
        other = DialogFilter(filter_id=8, title="Работа", include_peers=[peer(400)], exclude_archived=True)
        gateway = FakeGateway([folder, other], {200: None})

        result = await TelegramChatOrganizer(gateway).organize_joined_group(self.group())

        self.assertEqual([p.channel_id for p in folder.include_peers], [100, 200])
        self.assertEqual([p.channel_id for p in folder.pinned_peers], [100])
        self.assertEqual([p.channel_id for p in folder.exclude_peers], [300])
        self.assertFalse(folder.exclude_archived)
        self.assertEqual((folder.emoticon, folder.color, folder.contacts), ("📡", 5, True))
        self.assertEqual([p.channel_id for p in other.include_peers], [400])
        self.assertTrue(other.exclude_archived)
        self.assertEqual([call for call in gateway.calls if call[0] == "update_filter"], [("update_filter", 7)])
        self.assertTrue(result.folder_organized)
        self.assertTrue(result.archived)

    async def test_existing_peer_and_archive_are_idempotent_no_ops(self):
        folder = DialogFilter(include_peers=[peer(200)], exclude_archived=False)
        gateway = FakeGateway([folder], {200: 1})

        result = await TelegramChatOrganizer(gateway).organize_joined_group(self.group())

        self.assertEqual([p.channel_id for p in folder.include_peers], [200])
        self.assertNotIn("update_filter", [call[0] for call in gateway.calls])
        self.assertNotIn("archive", [call[0] for call in gateway.calls])
        self.assertFalse(result.folder_changed)
        self.assertFalse(result.archive_changed)

    async def test_chatlist_folder_preserves_shared_metadata(self):
        folder = DialogFilterChatlist(
            include_peers=[peer(100)], pinned_peers=[peer(100)],
            has_my_invites=True, emoticon="🔗", color=3,
        )
        gateway = FakeGateway([folder], {200: None})

        await TelegramChatOrganizer(gateway).organize_joined_group(self.group())

        self.assertEqual([p.channel_id for p in folder.include_peers], [100, 200])
        self.assertTrue(folder.has_my_invites)
        self.assertEqual((folder.emoticon, folder.color), ("🔗", 3))
        self.assertFalse(hasattr(folder, "exclude_archived"))

    async def test_missing_folder_creates_conservative_parser_filter(self):
        other = DialogFilter(filter_id=8, title="Работа", include_peers=[peer(400)])
        gateway = FakeGateway([other], {200: None})

        result = await TelegramChatOrganizer(gateway).organize_joined_group(self.group())

        self.assertIn(("create_filter", "парсер", [200]), gateway.calls)
        self.assertEqual([p.channel_id for p in other.include_peers], [400])
        self.assertEqual(result.folder_id, 12)

    async def test_archive_runs_only_after_refetched_folder_membership(self):
        folder = DialogFilter(include_peers=[])
        gateway = FakeGateway([folder], {200: None})

        await TelegramChatOrganizer(gateway).organize_joined_group(self.group())

        operations = [call[0] for call in gateway.calls]
        self.assertLess(operations.index("update_filter"), operations.index("archive"))
        self.assertGreater(operations[:operations.index("archive")].count("get_filters"), 1)

    async def test_failed_folder_verification_never_archives(self):
        folder = DialogFilter(include_peers=[])
        gateway = FakeGateway([folder], {200: None})

        async def filters_without_new_peer():
            gateway.calls.append(("get_filters",))
            if any(call[0] == "update_filter" for call in gateway.calls):
                folder.include_peers = []
            return gateway.filters

        gateway.get_dialog_filters = filters_without_new_peer

        with self.assertRaises(OrganizationFailure) as raised:
            await TelegramChatOrganizer(gateway).organize_joined_group(self.group())

        self.assertEqual(raised.exception.stage, "FOLDER_VERIFY")
        self.assertNotIn("archive", [call[0] for call in gateway.calls])

    async def test_reconciliation_batches_only_supplied_managed_groups(self):
        folder = DialogFilter(include_peers=[peer(100)])
        gateway = FakeGateway([folder], {200: None, 201: 1, 999: None})
        groups = [self.group(200, "One"), self.group(201, "Two")]

        results = await TelegramChatOrganizer(gateway).reconcile_managed_groups(groups)

        self.assertEqual([p.channel_id for p in folder.include_peers], [100, 200, 201])
        self.assertIn(("archive", [200]), gateway.calls)
        self.assertNotIn(999, [value for call in gateway.calls for value in (call[1] if len(call) > 1 and isinstance(call[1], list) else [])])
        self.assertEqual(len(results), 2)


if __name__ == "__main__":
    unittest.main()
