from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any


PARSER_FOLDER_TITLE = "парсер"


@dataclass(frozen=True)
class OrganizationResult:
    group_id: str
    folder_organized: bool
    archived: bool
    folder_id: int
    folder_type: str
    folder_changed: bool
    archive_changed: bool


class OrganizationFailure(RuntimeError):
    def __init__(
        self,
        stage: str,
        cause: BaseException,
        *,
        folder_organized: bool = False,
        archived: bool = False,
    ):
        code = str(getattr(cause, "code", None) or type(cause).__name__ or "RETRYABLE")
        super().__init__(code)
        self.stage = stage
        self.code = code
        self.cause = cause
        self.folder_organized = folder_organized
        self.archived = archived


def _folder_title(dialog_filter: Any) -> str:
    title = getattr(dialog_filter, "title", "")
    return str(getattr(title, "text", title) or "")


def _peer_key(peer: Any) -> tuple[str, int]:
    for kind, attribute in (
        ("channel", "channel_id"),
        ("chat", "chat_id"),
        ("user", "user_id"),
    ):
        value = getattr(peer, attribute, None)
        if value is not None:
            return kind, int(value)
    raise ValueError("Unsupported Telegram input peer")


class TelegramChatOrganizer:
    def __init__(self, gateway: Any, *, folder_title: str = PARSER_FOLDER_TITLE):
        self.gateway = gateway
        self.folder_title = folder_title
        self._lock = asyncio.Lock()

    async def organize_joined_group(self, group: dict[str, Any]) -> OrganizationResult:
        results = await self.reconcile_managed_groups([group])
        return results[0]

    async def reconcile_managed_groups(self, groups: list[dict[str, Any]]) -> list[OrganizationResult]:
        if not groups:
            return []
        async with self._lock:
            return await self._reconcile(groups)

    async def _reconcile(self, groups: list[dict[str, Any]]) -> list[OrganizationResult]:
        try:
            resolved = [(group, await self.gateway.resolve_input_peer(group)) for group in groups]
        except Exception as error:
            raise OrganizationFailure("PEER_RESOLVE", error) from error

        try:
            filters = await self.gateway.get_dialog_filters()
        except Exception as error:
            raise OrganizationFailure("FOLDER_READ", error) from error
        target = next((item for item in filters if _folder_title(item) == self.folder_title), None)
        folder_changed = False

        try:
            if target is None:
                target = await self.gateway.create_dialog_filter(
                    self.folder_title, [item[1] for item in resolved]
                )
                folder_changed = True
            else:
                existing = {_peer_key(peer) for peer in getattr(target, "include_peers", [])}
                missing = [peer for _, peer in resolved if _peer_key(peer) not in existing]
                clear_archive_exclusion = hasattr(target, "exclude_archived") and bool(target.exclude_archived)
                if missing:
                    target.include_peers = [*getattr(target, "include_peers", []), *missing]
                if clear_archive_exclusion:
                    target.exclude_archived = False
                if missing or clear_archive_exclusion:
                    await self.gateway.update_dialog_filter(int(target.id), target)
                    folder_changed = True
        except Exception as error:
            raise OrganizationFailure("FOLDER_MUTATE", error) from error

        try:
            refreshed_filters = await self.gateway.get_dialog_filters()
            refreshed = next(
                (
                    item for item in refreshed_filters
                    if int(getattr(item, "id", -1)) == int(target.id)
                    and _folder_title(item) == self.folder_title
                ),
                None,
            )
            included = {_peer_key(peer) for peer in getattr(refreshed, "include_peers", [])} if refreshed else set()
            if refreshed is None or any(_peer_key(peer) not in included for _, peer in resolved):
                raise RuntimeError("FOLDER_MEMBERSHIP_NOT_VERIFIED")
            if hasattr(refreshed, "exclude_archived") and bool(refreshed.exclude_archived):
                raise RuntimeError("ARCHIVED_CHATS_EXCLUDED")
        except OrganizationFailure:
            raise
        except Exception as error:
            raise OrganizationFailure("FOLDER_VERIFY", error) from error

        peers = [item[1] for item in resolved]
        try:
            before = await self.gateway.get_peer_folder_ids(peers)
            to_archive = [peer for peer in peers if before.get(_peer_key(peer)) != 1]
            if to_archive:
                await self.gateway.archive_peers(to_archive)
        except Exception as error:
            raise OrganizationFailure("ARCHIVE_MUTATE", error, folder_organized=True) from error

        try:
            after = await self.gateway.get_peer_folder_ids(peers)
            if any(after.get(_peer_key(peer)) != 1 for peer in peers):
                raise RuntimeError("ARCHIVE_NOT_VERIFIED")
        except Exception as error:
            raise OrganizationFailure("ARCHIVE_VERIFY", error, folder_organized=True) from error

        folder_type = type(refreshed).__name__
        archived_keys = {_peer_key(peer) for peer in to_archive}
        return [
            OrganizationResult(
                group_id=str(group["id"]),
                folder_organized=True,
                archived=True,
                folder_id=int(refreshed.id),
                folder_type=folder_type,
                folder_changed=folder_changed,
                archive_changed=_peer_key(peer) in archived_keys,
            )
            for group, peer in resolved
        ]
