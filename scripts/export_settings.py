"""Export this installation's HTTP configuration from a PRIVATE stopped SQLite copy."""

import base64
import json
import os
from pathlib import Path
import sqlite3
import sys
from urllib.parse import urlsplit


def export_settings(source):
    source = Path(source).resolve(strict=True)
    db = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA query_only=ON")
        if [row[0] for row in db.execute("PRAGMA quick_check")] != ["ok"]:
            raise ValueError("Source database integrity check failed")

        def rows(table):
            return [dict(row) for row in db.execute(f'SELECT * FROM "{table}"')]

        for table in ("tag", "monitor_tag", "maintenance", "monitor_maintenance",
                      "proxy", "docker_host", "remote_browser", "status_page_cname"):
            if rows(table):
                raise ValueError(f"Unsupported nonempty configuration table: {table}")

        monitors = rows("monitor")
        notifications = rows("notification")
        pages = rows("status_page")
        groups = rows("group")
        if (len(monitors), len(notifications), len(pages), len(groups)) != (6, 1, 1, 1):
            raise ValueError("Inventory differs from approved 6 monitors / 1 notification / 1 page / 1 group")
        links = rows("monitor_notification")
        group_links = rows("monitor_group")
        if len(links) != 6 or len(group_links) != 6:
            raise ValueError("Unexpected monitor relationship counts")
        monitor_ids = {row["id"] for row in monitors}
        if ({row["monitor_id"] for row in links} != monitor_ids
                or {row["monitor_id"] for row in group_links} != monitor_ids):
            raise ValueError("Monitor relationships are incomplete")
        if any(row["notification_id"] != notifications[0]["id"] for row in links):
            raise ValueError("Unknown notification reference")
        if any(row["group_id"] != groups[0]["id"] for row in group_links):
            raise ValueError("Unknown status-page group reference")
        if groups[0]["status_page_id"] != pages[0]["id"] or not groups[0]["public"]:
            raise ValueError("Unsupported status-page grouping")

        exported = []
        for row in monitors:
            if row["type"] != "http":
                raise ValueError("Only HTTP monitors are supported")
            for key in ("parent", "proxy_id", "docker_host", "remote_browser"):
                if row.get(key) not in (None, 0):
                    raise ValueError(f"Unsupported monitor reference: {key}")
            old_id = row.pop("id")
            row.pop("user_id")
            was_active = bool(row.pop("active"))
            for key in ("parent", "proxy_id", "docker_host", "remote_browser"):
                row[key] = None
            # Keep persisted HTTP fields, including authentication and TLS material.
            # Let the released app validate them; never copy SQLite schema to MySQL.
            for old, new in (
                ("accepted_statuscodes_json", "accepted_statuscodes"),
                ("kafka_producer_brokers", "kafkaProducerBrokers"),
                ("kafka_producer_sasl_options", "kafkaProducerSaslOptions"),
                ("rabbitmq_nodes", "rabbitmqNodes"),
                ("conditions", "conditions"),
            ):
                value = row.pop(old, None)
                row[new] = json.loads(value) if value is not None else None
            row["notificationIDList"] = {str(notifications[0]["id"]): True}
            exported.append({"oldId": old_id, "wasActive": was_active, "config": row})

        page = pages[0]
        if not page["published"] or page.get("password"):
            raise ValueError("Unpublished/password-protected status pages require manual restoration")
        fields = {
            "slug": "slug", "title": "title", "description": "description",
            "theme": "theme", "auto_refresh_interval": "autoRefreshInterval",
            "show_tags": "showTags", "custom_css": "customCSS", "footer_text": "footerText",
            "show_powered_by": "showPoweredBy", "analytics_id": "analyticsId",
            "analytics_script_url": "analyticsScriptUrl", "analytics_type": "analyticsType",
            "show_certificate_expiry": "showCertificateExpiry",
            "show_only_last_heartbeat": "showOnlyLastHeartbeat", "rss_title": "rssTitle",
        }
        ignored = {"id", "icon", "published", "password", "modified_date", "created_date"}
        for column in db.execute('PRAGMA table_info("status_page")'):
            key, default = column["name"], column["dflt_value"]
            if key not in fields and key not in ignored and page.get(key) is not None:
                if default is None or str(page[key]) != default.strip("()'\""):
                    raise ValueError(f"Status-page field requires manual restoration: {key}")
        config = {target: page.get(column) for column, target in fields.items()}
        config["domainNameList"] = []
        logo = page.get("icon") or "/icon.svg"
        if logo.startswith("/upload/"):
            upload_root = (source.parent / "upload").resolve()
            logo_file = (source.parent / urlsplit(logo).path.lstrip("/")).resolve(strict=True)
            if not logo_file.is_relative_to(upload_root):
                raise ValueError("Status-page logo is outside the upload directory")
            data = logo_file.read_bytes()
            if not data.startswith(b"\x89PNG\r\n\x1a\n"):
                raise ValueError("The UI API can import PNG logos only; restore this asset manually")
            logo = "data:image/png;base64," + base64.b64encode(data).decode("ascii")
        page_export = {
            "config": config,
            "logo": logo,
            "groups": [{
                "name": groups[0]["name"],
                "monitorList": [
                    {"id": row["monitor_id"], "sendUrl": bool(row.get("send_url")),
                     "url": row.get("custom_url")}
                    for row in sorted(group_links, key=lambda row: row["weight"])
                ],
            }],
        }

        settings = {}
        manual_settings = []
        for row in rows("setting"):
            try:
                value = json.loads(row["value"])
            except (json.JSONDecodeError, TypeError):
                value = row["value"]
            if row["type"] == "general":
                settings[row["key"]] = value
            elif row["key"] not in ("jwtSecret", "dbVersion"):
                manual_settings.append({"key": row["key"], "type": row["type"], "value": value})
        if settings.get("disableAuth"):
            raise ValueError("Source has authentication disabled; review this setting before restoration")
        notification = notifications[0]
        notification_config = json.loads(notification["config"])
        notification_config.update(name=notification["name"], isDefault=bool(notification["is_default"]),
                                   applyExisting=False)
        notification_config.pop("id", None)
        return {
            "format": 1,
            "notifications": [{"oldId": notification["id"], "config": notification_config}],
            "monitors": exported,
            "statusPage": page_export,
            "settings": settings,
            "manualSettings": manual_settings,
            "manualSettingsReviewed": not manual_settings,
        }
    finally:
        db.close()


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("Usage: python scripts/export_settings.py PRIVATE/kuma.db PRIVATE/settings.json")
    try:
        document = export_settings(sys.argv[1])
        descriptor = os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(document, output, ensure_ascii=False, indent=2)
        print(f"Exported 6 HTTP monitors, 1 notification and 1 status page; "
              f"{len(document['manualSettings'])} non-general settings require private review.")
    except (ValueError, OSError, sqlite3.Error, KeyError) as error:
        # Do not print SQL rows, URLs, credential values, or database content.
        detail = str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError) else type(error).__name__
        sys.exit(f"Export stopped: {detail}. No source writes occurred.")
